import type { ConnectionStatus } from '../../lib/store/table-store';
import { cx } from '../../lib/cx';

/**
 * The state of the link, said plainly.
 *
 * Three states a player can act on: connected, and the table hears you;
 * reconnecting, and it does not yet; disconnected, and it will not until you do
 * something. Anything vaguer than that leaves somebody clicking Fold into a
 * socket that is not there.
 */
const LABELS: Readonly<Record<ConnectionStatus, { text: string; tone: string; live: boolean }>> = {
  idle: { text: 'Connecting', tone: 'bg-white/10 text-neutral-400', live: false },
  connecting: { text: 'Connecting', tone: 'bg-white/10 text-neutral-400', live: false },
  open: { text: 'Connected', tone: 'bg-accent/15 text-accent', live: true },
  reconnecting: { text: 'Reconnecting', tone: 'bg-amber-300/15 text-amber-200', live: false },
  closed: { text: 'Disconnected', tone: 'bg-danger/15 text-danger', live: false },
  error: { text: 'Disconnected', tone: 'bg-danger/15 text-danger', live: false },
};

export function ConnectionBadge({
  status,
  attempt,
  notice,
}: {
  status: ConnectionStatus;
  attempt: number;
  notice: string | null;
}) {
  const label = LABELS[status];

  return (
    <span
      // Polite, not assertive: a blip on the line should not talk over the
      // commentary on the hand.
      aria-live="polite"
      title={notice ?? undefined}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-[0.65rem] font-semibold tracking-wide uppercase',
        label.tone,
      )}
    >
      <span
        aria-hidden
        className={cx(
          'h-1.5 w-1.5 rounded-full bg-current',
          status === 'reconnecting' && 'animate-pulse-ring',
        )}
      />
      {label.text}
      {status === 'reconnecting' && attempt > 0 ? (
        <span className="tabular font-normal opacity-70">#{attempt}</span>
      ) : null}
    </span>
  );
}
