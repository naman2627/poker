/**
 * Where the client thinks the server is, and whether it should bother asking.
 *
 * The default is the real server. Fixture mode still exists — it replays a
 * recorded hand with no server, no database and no SMS gateway, which is how the
 * interface is reviewed on its own — but it is opt-in now, because a client that
 * silently falls back to a recording when the server is down is a client that
 * shows a player a table they are not sitting at.
 */
export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:4000';

const FIXTURE_FLAG = process.env.NEXT_PUBLIC_FIXTURE ?? '';

/** `?fixture=1` asks for the recording; `?live=1` insists on the server. */
export function isFixtureMode(search?: string): boolean {
  const params = new URLSearchParams(search ?? '');
  if (params.get('fixture') === '1') return true;
  if (params.get('live') === '1') return false;
  return FIXTURE_FLAG === '1';
}

export function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}
