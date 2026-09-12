'use client';

import { useEffect } from 'react';
import { CLIENT_EVENTS, TableConfigSchema } from '@poker/shared';
import { FIXTURE_CONFIG } from '../../fixtures/scripted-hand';
import { useFixtureMode } from '../use-fixture';
import { useTableStore } from '../store/table-store';
import { createFixtureTransport } from './fixture-transport';
import { createSocketTransport } from './socket-transport';
import type { Transport } from './transport';

/**
 * Open one connection for one table, and close it on the way out.
 *
 * The transport is created inside the effect, not in a `useMemo`: it owns a real
 * socket, and a value React is free to throw away and recompute is the wrong
 * place to keep one.
 *
 * `table:join` is registered as the rejoin step rather than being sent once,
 * because a socket that drops and comes back is a *new* socket as far as the
 * server is concerned — it is not at any table until it says so again.
 */
export function useTableConnection(code: string, token: string | null): void {
  const fixture = useFixtureMode();
  const attach = useTableStore((store) => store.attach);
  const detach = useTableStore((store) => store.detach);

  useEffect(() => {
    if (fixture) {
      attach(createFixtureTransport(), FIXTURE_CONFIG);
      return () => {
        detach();
      };
    }

    if (token === null) return;

    const transport = createSocketTransport(token);
    attach(transport, null);
    useTableStore.getState().setRejoin(() => join(transport, code));
    void join(transport, code);

    return () => {
      detach();
    };
  }, [attach, detach, code, fixture, token]);
}

/**
 * Say which table this socket is here for.
 *
 * The ack carries the table's settings — the action timer's length among them —
 * so this is also where the client learns how long a turn is.
 */
async function join(transport: Transport, code: string): Promise<void> {
  const ack = await transport.emit(CLIENT_EVENTS.tableJoin, { code });
  if (!ack.ok) return;

  const config = TableConfigSchema.safeParse((ack.data as { config?: unknown }).config);
  if (config.success) useTableStore.getState().setConfig(config.data);
}
