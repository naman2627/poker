import type { FastifyInstance } from 'fastify';
import { Server as SocketServer, type Socket } from 'socket.io';
import {
  CLIENT_EVENTS,
  ChatSendSchema,
  PlayerActionSchema,
  PlayerEmoteSchema,
  PlayerRebuySchema,
  PlayerShowSchema,
  PlayerSitOutSchema,
  StateResyncSchema,
  TableConfigSchema,
  TableCreateSchema,
  TableJoinSchema,
  TablePauseSchema,
  TableSitSchema,
  type Ack,
  type ApiError,
} from '@poker/shared';
import type { AuthDependencies } from './auth/dependencies';
import type { UserRecord } from './auth/ports';
import type { AppConfig } from './config';
import { sendTableError, type Connection } from './table/broadcast';
import { TableError } from './table/errors';
import type { TableRegistry } from './table/registry';
import type { TableRuntime } from './table/runtime';

/**
 * Socket.IO on the same HTTP server Fastify is using.
 *
 * Handlers here are transport only: authenticate, validate with a zod schema
 * from @poker/shared, hand the result to a TableRuntime, and answer the ack.
 * No poker rule is written in this file, and no table state is serialised here
 * — that happens in exactly one place, table/broadcast.ts.
 */
export interface RealtimeDeps {
  readonly config: AppConfig;
  readonly auth: AuthDependencies;
  readonly registry: TableRegistry;
}

/** Ten actions a second is far more than a person can click, and cheap to allow. */
const ACTION_RATE_LIMIT = { limit: 10, windowMs: 1_000 };

interface SocketState {
  user: UserRecord;
  table: TableRuntime | null;
  actionTimes: number[];
}

export function attachRealtime(app: FastifyInstance, deps: RealtimeDeps): SocketServer {
  const io = new SocketServer(app.server, {
    cors: { origin: deps.config.WEB_ORIGIN, credentials: true },
    serveClient: false,
  });

  const sockets = new WeakMap<Socket, SocketState>();

  /**
   * The handshake carries the access token. A socket that cannot prove who it
   * is never reaches a table: it is refused here with a typed error, which the
   * client reads off `err.data`.
   */
  io.use((socket, next) => {
    const token = tokenFrom(socket);
    if (!token) {
      next(handshakeError('UNAUTHENTICATED', 'this connection needs an access token'));
      return;
    }

    deps.auth.tokens
      .authenticate(token)
      .then((user) => {
        sockets.set(socket, { user, table: null, actionTimes: [] });
        next();
      })
      .catch(() => {
        next(handshakeError('UNAUTHENTICATED', 'that access token is not valid any more'));
      });
  });

  io.on('connection', (socket) => {
    const session = sockets.get(socket);
    if (!session) {
      socket.disconnect(true);
      return;
    }

    const connection = connectionFor(socket, session.user.id);
    app.log.info({ socketId: socket.id, userId: session.user.id }, 'socket connected');

    const join = async (table: TableRuntime): Promise<void> => {
      if (session.table && session.table !== table) session.table.detach(socket.id);
      session.table = table;
      await table.attach(connection, {
        displayName: session.user.displayName,
        avatarSeed: session.user.avatarSeed,
      });
    };

    const currentTable = (): TableRuntime => {
      if (!session.table) throw TableError.invalidAction('join a table first');
      return session.table;
    };

    on(socket, connection, CLIENT_EVENTS.tableCreate, async (raw) => {
      requireProfile(session.user);
      const { config } = TableCreateSchema.parse(raw ?? {});
      const table = deps.registry.create(TableConfigSchema.parse(config ?? {}), session.user.id);
      await join(table);
      return { code: table.code, config: table.config, hostUserId: table.hostUserId };
    });

    on(socket, connection, CLIENT_EVENTS.tableJoin, async (raw) => {
      requireProfile(session.user);
      const { code } = TableJoinSchema.parse(raw);
      const table = deps.registry.require(code);
      await join(table);
      return { code: table.code, config: table.config, hostUserId: table.hostUserId };
    });

    on(socket, connection, CLIENT_EVENTS.tableSit, async (raw) => {
      const { seatIndex, buyIn } = TableSitSchema.parse(raw);
      await currentTable().sit(session.user.id, seatIndex, buyIn);
      return { seatIndex };
    });

    on(socket, connection, CLIENT_EVENTS.tableLeave, async () => {
      await currentTable().leave(session.user.id);
      return { left: true };
    });

    on(socket, connection, CLIENT_EVENTS.playerReady, async () => {
      await currentTable().ready(session.user.id);
      return { ready: true };
    });

    on(socket, connection, CLIENT_EVENTS.playerSitOut, async (raw) => {
      const { sittingOut } = PlayerSitOutSchema.parse(raw);
      await currentTable().setSittingOut(session.user.id, sittingOut);
      return { sittingOut };
    });

    on(socket, connection, CLIENT_EVENTS.playerRebuy, async (raw) => {
      const { amount } = PlayerRebuySchema.parse(raw);
      await currentTable().rebuy(session.user.id, amount);
      return { amount };
    });

    on(socket, connection, CLIENT_EVENTS.playerShow, async (raw) => {
      const { handId } = PlayerShowSchema.parse(raw);
      await currentTable().show(session.user.id, handId);
      return { shown: true };
    });

    on(socket, connection, CLIENT_EVENTS.tablePause, async (raw) => {
      const { paused } = TablePauseSchema.parse(raw);
      await currentTable().pause(session.user.id, paused);
      return { paused };
    });

    on(socket, connection, CLIENT_EVENTS.playerAction, async (raw) => {
      rateLimitAction(session);
      const payload = PlayerActionSchema.parse(raw);
      const table = currentTable();
      await table.playerAction(session.user.id, payload);
      return { actionSeq: table.actionSeq };
    });

    on(socket, connection, CLIENT_EVENTS.chatSend, (raw) => {
      const { text } = ChatSendSchema.parse(raw);
      currentTable().chat(session.user.id, text);
      return { sent: true };
    });

    on(socket, connection, CLIENT_EVENTS.playerEmote, async (raw) => {
      const { emote } = PlayerEmoteSchema.parse(raw);
      await currentTable().emote(session.user.id, emote);
      return { emote };
    });

    on(socket, connection, CLIENT_EVENTS.stateResync, async (raw) => {
      const { fromVersion } = StateResyncSchema.parse(raw);
      const table = currentTable();
      // A resync is always the whole state: `fromVersion` says what the client
      // has, and answering with everything is always a correct answer to that.
      await table.resync(session.user.id);
      return { fromVersion, version: table.version };
    });

    socket.on('disconnect', (reason) => {
      session.table?.detach(socket.id);
      app.log.info({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}

/**
 * Wires one client event to a handler, with the same shape every time: parse,
 * do, acknowledge. A refusal comes back through the ack as a typed error and,
 * for clients that are not watching the ack, as `table:error`.
 */
function on(
  socket: Socket,
  connection: Connection,
  event: string,
  handler: (payload: unknown) => Promise<unknown> | unknown,
): void {
  socket.on(event, (payload: unknown, ack?: (response: Ack<unknown>) => void) => {
    void (async () => {
      try {
        const data = await handler(payload);
        ack?.({ ok: true, data });
      } catch (error: unknown) {
        const body = toApiError(error);
        ack?.({ ok: false, error: body });
        sendTableError(connection, body);
      }
    })();
  });
}

function toApiError(error: unknown): ApiError {
  if (error instanceof TableError) return error.toBody();

  // A zod failure is the client sending nonsense, not the server breaking.
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues: { message: string; path: PropertyKey[] }[] }).issues;
    const first = issues[0];
    const field = first?.path.join('.');
    const message = first?.message ?? 'that request did not make sense';
    return { code: 'INVALID_INPUT', message: field ? `${field}: ${message}` : message };
  }

  return { code: 'INTERNAL', message: 'something went wrong on our side' };
}

/** The socket, as the table sees it: an id, a user, and a way to say things. */
function connectionFor(socket: Socket, userId: string): Connection {
  return {
    socketId: socket.id,
    userId,
    emit: (event, payload) => socket.emit(event, payload),
    disconnect: () => socket.disconnect(true),
  };
}

function tokenFrom(socket: Socket): string | null {
  const auth: unknown = socket.handshake.auth;
  if (typeof auth === 'object' && auth !== null && 'token' in auth) {
    const token = (auth as { token?: unknown }).token;
    if (typeof token === 'string' && token.length > 0) return token;
  }

  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}

/** Socket.IO passes `err.data` to the client's `connect_error` handler. */
function handshakeError(code: string, message: string): Error & { data: ApiError } {
  const error = new Error(message) as Error & { data: ApiError };
  error.data = { code: code as ApiError['code'], message };
  return error;
}

function requireProfile(user: UserRecord): void {
  if (user.displayName === '') {
    throw TableError.forbidden('choose a display name before joining a table');
  }
}

function rateLimitAction(session: SocketState): void {
  const now = Date.now();
  session.actionTimes = session.actionTimes.filter((at) => now - at < ACTION_RATE_LIMIT.windowMs);

  if (session.actionTimes.length >= ACTION_RATE_LIMIT.limit) {
    throw TableError.rateLimited('slow down — too many actions');
  }
  session.actionTimes.push(now);
}
