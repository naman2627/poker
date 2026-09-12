import type { ActionPromptPayload, Card, HandResultPayload, PublicTableState } from '@poker/shared';
import { CommunityCards } from './CommunityCards';
import { SeatView } from './SeatView';
import { chipOffset, seatPositions } from '../../lib/seats';
import { chipsOnFelt, potTotal } from '../../lib/store/patch';
import { ChipStack } from './ChipStack';
import { cx } from '../../lib/cx';

/**
 * The felt.
 *
 * Seats are placed on an ellipse by `lib/seats.ts`, with the viewer pinned to
 * bottom-centre and everyone else rotating around them — so a player's own seat
 * is in the same place at every table they ever sit at, and the player on their
 * left is on their left.
 */
export interface TableFeltProps {
  readonly state: PublicTableState;
  readonly prompt: ActionPromptPayload | null;
  readonly result: HandResultPayload | null;
  readonly viewerCards: readonly Card[] | null;
  readonly awarded: number;
  readonly timeoutSec: number;
}

export function TableFelt({
  state,
  prompt,
  result,
  viewerCards,
  awarded,
  timeoutSec,
}: TableFeltProps) {
  const positions = seatPositions(state.seats.length, state.viewerSeatIndex);
  const winners = new Set(result?.awards.map((award) => award.seatIndex) ?? []);
  const mucked = new Set(state.muckedSeats);

  // The clock a seat is on: the prompt is the most recent word on it, and the
  // state's own deadline is the fallback for a client that joined mid-turn.
  const deadlineFor = (seatIndex: number): number | null => {
    if (prompt?.seatIndex === seatIndex) return prompt.deadlineTs;
    if (state.toActSeat === seatIndex) return state.actionDeadlineTs;
    return null;
  };

  return (
    <div className="relative mx-auto aspect-[4/5] w-full max-w-md sm:aspect-[16/10] sm:max-w-4xl">
      <div
        className={cx(
          'absolute inset-[6%] rounded-[50%]',
          'bg-felt-800 bg-[radial-gradient(ellipse_at_50%_38%,var(--color-felt-700),var(--color-felt-900))]',
          'ring-rail-700 shadow-[inset_0_2px_18px_rgba(0,0,0,0.45)] ring-8',
        )}
      />

      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center px-4">
        <CommunityCards
          board={state.board}
          potTotal={potTotal(state, awarded)}
          pots={state.pots}
          chipsOnFelt={chipsOnFelt(state)}
        />
      </div>

      {positions.map((position) => {
        const seat = state.seats[position.seatIndex] ?? null;
        const offset = chipOffset(position);

        return (
          <div key={position.seatIndex}>
            <div
              style={{
                left: `${String(position.xPercent)}%`,
                top: `${String(position.yPercent)}%`,
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2"
            >
              {seat === null ? (
                <EmptySeat seatIndex={position.seatIndex} />
              ) : (
                <SeatView
                  seat={seat}
                  isViewer={position.seatIndex === state.viewerSeatIndex}
                  isToAct={state.toActSeat === position.seatIndex}
                  isButton={state.buttonSeat === position.seatIndex}
                  isWinner={winners.has(position.seatIndex)}
                  blind={
                    state.sbSeat === position.seatIndex
                      ? 'small'
                      : state.bbSeat === position.seatIndex
                        ? 'big'
                        : null
                  }
                  viewerCards={viewerCards}
                  deadlineTs={deadlineFor(position.seatIndex)}
                  timeoutSec={timeoutSec}
                  mucked={mucked.has(position.seatIndex)}
                />
              )}
            </div>

            {seat && seat.committedThisRound > 0 ? (
              <div
                style={{
                  left: `${String(position.xPercent + offset.dx)}%`,
                  top: `${String(position.yPercent + offset.dy)}%`,
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2"
              >
                <ChipStack amount={seat.committedThisRound} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function EmptySeat({ seatIndex }: { seatIndex: number }) {
  return (
    <div className="grid h-16 w-[7.5rem] place-items-center rounded-xl border border-dashed border-white/10 sm:w-36">
      <span className="text-[0.65rem] tracking-wide text-neutral-500 uppercase">
        Seat {seatIndex + 1}
      </span>
    </div>
  );
}
