import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two processes an end-to-end run needs, started for real.
 *
 * Nothing here is a stub. It is the game server and the Next app, on their own
 * ports, talking over a socket — which is the only way a test of "four browsers
 * play a hand" is worth running.
 *
 * Three things are different from a deployment, and all three are refused in
 * production by `assertNotProduction`:
 *
 *   AUTH_STORE=memory   so there is no Postgres and no Redis to install
 *   TABLE_RNG_SEED      so the deck is the same deck on every run
 *   short table timings so the showdown beat is 200ms rather than two seconds
 *
 * The one-time codes are read back out of the server's own console output. That
 * is deliberately not a dev endpoint: the code stays where the SMS provider put
 * it, and the test reads the log the same way a developer would.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

export const SERVER_PORT = 4_100;
export const WEB_PORT = 3_100;
export const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
export const SERVER_URL = `http://127.0.0.1:${String(SERVER_PORT)}`;

export const ARTIFACTS = join(here, '.artifacts');
export const SERVER_LOG = join(ARTIFACTS, 'server.log');

/** The seed the deck is dealt from. Change it and the expected hands change. */
export const RNG_SEED = 'e2e-one-complete-hand';

const started: ChildProcess[] = [];

export async function startServers(): Promise<void> {
  // A port still held by a previous run is worse than a failure: the health
  // check would pass against the old process, and the test would then read an
  // OTP log that nothing is writing to any more. Refuse to start instead.
  await assertPortFree(SERVER_PORT, 'the game server');
  await assertPortFree(WEB_PORT, 'the web app');

  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const serverLog = createWriteStream(SERVER_LOG, { flags: 'a' });

  const server = run(
    'pnpm',
    ['--filter', '@poker/server', 'dev'],
    {
      NODE_ENV: 'development',
      PORT: String(SERVER_PORT),
      WEB_ORIGIN: WEB_URL,
      AUTH_STORE: 'memory',
      SMS_PROVIDER: 'console',
      TABLE_RNG_SEED: RNG_SEED,
      // Short enough not to pad the run, long enough to still be a real pause
      // that the client has to wait out rather than skip.
      SHOWDOWN_BEAT_MS: '200',
      // Long enough for four browsers to press "I'm in" one after another, so
      // the first hand is dealt to the whole table rather than to whoever
      // finished clicking first.
      DEAL_DELAY_MS: '2000',
    },
    serverLog,
  );

  const web = run(
    'pnpm',
    ['--filter', '@poker/web', 'dev'],
    {
      NODE_ENV: 'development',
      // `next dev` takes its port from the environment; the web script no
      // longer pins one so that this can be a different port from a dev server
      // somebody already has running.
      PORT: String(WEB_PORT),
      NEXT_PUBLIC_SERVER_URL: SERVER_URL,
      NEXT_PUBLIC_FIXTURE: '0',
    },
    createWriteStream(join(ARTIFACTS, 'web.log'), { flags: 'a' }),
  );

  started.push(server, web);

  await waitForOk(`${SERVER_URL}/health`, 60_000, 'the game server');
  await waitForOk(WEB_URL, 120_000, 'the web app');
}

/**
 * Stop both processes, and everything they started.
 *
 * `pnpm` is a shim that spawns the real server; killing the shim on Windows
 * leaves the grandchild holding the port, which the next run then mistakes for
 * a healthy server of its own. The whole tree has to go.
 */
export function stopServers(): void {
  for (const child of started.splice(0)) killTree(child);
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function assertPortFree(port: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => {
      reject(
        new Error(
          `port ${String(port)} is already in use, so ${what} cannot start. ` +
            'Something from a previous run is probably still alive — stop it and try again.',
        ),
      );
    });
    probe.once('listening', () => {
      probe.close(() => {
        resolve();
      });
    });
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * The most recent code the server printed for a phone.
 *
 * The console SMS provider prints `code: 424242` under the number it was sent
 * to; this reads the last such block for `phone`.
 */
export function lastOtpCodeFor(phone: string): string | null {
  let log: string;
  try {
    log = readFileSync(SERVER_LOG, 'utf8');
  } catch {
    return null;
  }

  const escaped = phone.replace(/[+]/g, '\\+');
  const pattern = new RegExp(`to:\\s*${escaped}[\\s\\S]{0,200}?code:\\s*(\\d{6})`, 'g');

  let code: string | null = null;
  for (const match of log.matchAll(pattern)) code = match[1] ?? code;
  return code;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  log: NodeJS.WritableStream,
): ChildProcess {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    // pnpm on Windows is a .cmd shim, which needs a shell to be found.
    shell: process.platform === 'win32',
    // Elsewhere, its own process group, so the whole tree can be signalled.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

async function waitForOk(url: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(400);
  }

  throw new Error(`${what} did not come up at ${url} within ${String(timeoutMs)}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
