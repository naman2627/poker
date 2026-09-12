'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiveLeaderboardRow } from '@poker/shared';
import { chips } from '../../lib/format';
import { signedChips } from '../../lib/stats/format';
import { cx } from '../../lib/cx';
import { Avatar } from '../ui/Avatar';

/**
 * The live board, beside the felt.
 *
 * Everything in it came off `state:sync` or `state:patch` — the server
 * recomputes it whenever a stack moves, and this component draws what arrived.
 * Nothing is totted up here.
 *
 * Two details worth the code they cost:
 *
 *   - it is collapsible, and it remembers. At a nine-handed table on a phone
 *     this is most of the screen, and a player who closed it does not want it
 *     back every time somebody raises.
 *
 *   - the viewer's own row pins to the top when it would otherwise have
 *     scrolled out of sight. Not always — pinning a row that is already visible
 *     would show it twice, which is worse than not pinning it at all — so the
 *     list watches whether the real row is on screen and pins only when it is
 *     not. That is what `IntersectionObserver` is doing below; in an
 *     environment without one, the row is simply never pinned, which is the
 *     same as the panel behaved before.
 */
export function LiveLeaderboard({
  rows,
  viewerUserId,
  bigBlind,
}: {
  rows: readonly LiveLeaderboardRow[];
  viewerUserId: string | null;
  bigBlind: number;
}) {
  const [open, setOpen] = useState(true);
  const scroller = useRef<HTMLDivElement | null>(null);
  const ownRow = useRef<HTMLLIElement | null>(null);
  const [ownRowVisible, setOwnRowVisible] = useState(true);

  const viewer = rows.find((row) => row.userId === viewerUserId) ?? null;

  useEffect(() => {
    const target = ownRow.current;
    const root = scroller.current;
    // Nothing to watch: the panel is shut, the viewer is not seated, or this
    // browser has no observer. The row simply never pins, which is what the
    // `true` it starts at already says — so there is nothing to set here.
    if (!open || target === null || root === null || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setOwnRowVisible(entry.isIntersecting);
      },
      { root, threshold: 0.6 },
    );

    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [open, rows.length, viewer?.userId]);

  if (rows.length === 0) return null;

  // Pinned only while the panel is open and the real row has actually scrolled
  // out of sight. Drawing the same player twice is worse than not pinning.
  const pinned = open && viewer !== null && !ownRowVisible;

  return (
    <section
      className="overflow-hidden rounded-2xl border border-white/10 bg-black/25"
      aria-label="Table leaderboard"
      data-testid="live-leaderboard"
    >
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-white/5"
      >
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-neutral-300 uppercase">
          Chip counts
        </h2>
        <span className="tabular text-xs text-neutral-500">
          {rows.length} player{rows.length === 1 ? '' : 's'}
        </span>
        <span aria-hidden className="text-neutral-500">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-white/10">
          {pinned && viewer !== null ? (
            <div className="border-b border-white/10 bg-white/[0.06]">
              <Row row={viewer} rank={rows.indexOf(viewer) + 1} bigBlind={bigBlind} isViewer />
            </div>
          ) : null}

          <div ref={scroller} className="max-h-72 overflow-y-auto">
            <ol>
              {rows.map((row, index) => {
                const isViewer = row.userId === viewerUserId;
                return (
                  <li key={row.userId} ref={isViewer ? ownRow : null}>
                    <Row row={row} rank={index + 1} bigBlind={bigBlind} isViewer={isViewer} />
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Row({
  row,
  rank,
  bigBlind,
  isViewer,
}: {
  row: LiveLeaderboardRow;
  rank: number;
  bigBlind: number;
  isViewer: boolean;
}) {
  // Big blinds are how a poker player reads a stack: "twelve big blinds" says
  // something "600" does not, at a table where the blind might be any number.
  const inBigBlinds = bigBlind > 0 ? Math.floor(row.stack / bigBlind) : 0;

  return (
    <div className={cx('flex items-center gap-3 px-4 py-2.5', isViewer ? 'bg-white/[0.04]' : null)}>
      <span className="tabular w-5 shrink-0 text-xs text-neutral-500">{rank}</span>
      <Avatar seed={row.avatarSeed} name={row.displayName} size={28} />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-neutral-100">
          {row.displayName === '' ? 'Seat ' + String(row.seatIndex + 1) : row.displayName}
          {isViewer ? <span className="ml-1.5 text-xs text-neutral-500">(you)</span> : null}
        </span>
        <span className="tabular block text-xs text-neutral-500">
          {row.handsWon} won &middot; best {chips(row.biggestPot)}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span className="tabular block text-sm font-semibold text-neutral-50">
          {chips(row.stack)}
        </span>
        <span
          className={cx(
            'tabular block text-xs',
            row.net > 0 ? 'text-accent' : row.net < 0 ? 'text-danger' : 'text-neutral-500',
          )}
        >
          {signedChips(row.net)}
          <span className="ml-1 text-neutral-600">{inBigBlinds}bb</span>
        </span>
      </span>
    </div>
  );
}
