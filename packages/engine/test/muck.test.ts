import { describe, expect, it } from 'vitest';
import { resolveShowdown, showdownOrder } from '../src/showdown';
import type { TableState } from '../src/types';
import { showdownTable } from './helpers';

/**
 * Who turns over, and in what order.
 *
 * Two rules, both of them the table's and neither of them the client's:
 *
 *   the last player to bet or raise on the final street shows first, and if
 *   nobody bet, the first live seat left of the button does
 *
 *   after that, a hand only has to be shown if it can still win something —
 *   everything else is mucked, and a mucked hand's cards never leave the server
 */
function withAggressor(state: TableState, lastAggressorSeat: number | null): TableState {
  return { ...state, lastAggressorSeat };
}

describe('showdownOrder', () => {
  it('starts with the last aggressor', () => {
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 0,
        seats: [
          { seatIndex: 0, hole: 'Ah Kh', committed: 100 },
          { seatIndex: 1, hole: 'Qs Qd', committed: 100 },
          { seatIndex: 3, hole: '9s 9d', committed: 100 },
        ],
      }),
      3,
    );

    expect(showdownOrder(table)).toEqual([3, 0, 1]);
  });

  it('starts left of the button when nobody bet the last street', () => {
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 3,
        seats: [
          { seatIndex: 0, hole: 'Ah Kh', committed: 100 },
          { seatIndex: 1, hole: 'Qs Qd', committed: 100 },
          { seatIndex: 3, hole: '9s 9d', committed: 100 },
        ],
      }),
      null,
    );

    expect(showdownOrder(table)).toEqual([0, 1, 3]);
  });

  it('skips a seat that folded, even if it was the last to raise', () => {
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 0,
        seats: [
          { seatIndex: 0, hole: 'Ah Kh', committed: 100 },
          { seatIndex: 1, hole: 'Qs Qd', committed: 100, status: 'folded' },
          { seatIndex: 3, hole: '9s 9d', committed: 100 },
        ],
      }),
      1,
    );

    expect(showdownOrder(table)).toEqual([3, 0]);
  });
});

describe('mucking', () => {
  it('shows the first hand and mucks everything that cannot beat it', () => {
    // Seat 3 has the nuts here and is first to show; nobody behind can beat it.
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 0,
        seats: [
          { seatIndex: 0, hole: '7h 8h', committed: 100 },
          { seatIndex: 1, hole: '3s 3d', committed: 100 },
          { seatIndex: 3, hole: 'Ah Ad', committed: 100 },
        ],
      }),
      3,
    );

    const { revealed, mucked } = resolveShowdown(table);

    expect(revealed.map((reveal) => reveal.seatIndex)).toEqual([3]);
    expect(mucked.map((muck) => muck.seatIndex)).toEqual([0, 1]);
    expect(revealed[0]?.order).toBe(0);
  });

  it('shows a later hand that beats what is already face up', () => {
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 0,
        seats: [
          { seatIndex: 0, hole: '3s 3d', committed: 100 },
          { seatIndex: 1, hole: 'Ah Ad', committed: 100 },
          { seatIndex: 3, hole: '7h 8h', committed: 100 },
        ],
      }),
      0,
    );

    const { revealed, mucked } = resolveShowdown(table);

    // Seat 0 shows because it was asked; seat 1 shows because it beats seat 0;
    // seat 3 has nothing to prove and mucks.
    expect(revealed.map((reveal) => reveal.seatIndex)).toEqual([0, 1]);
    expect(revealed.map((reveal) => reveal.order)).toEqual([0, 1]);
    expect(mucked.map((muck) => muck.seatIndex)).toEqual([3]);
  });

  it('shows both halves of a tie', () => {
    const table = withAggressor(
      showdownTable({
        board: 'As Ks Qh Jd 9c',
        buttonSeat: 0,
        seats: [
          { seatIndex: 0, hole: 'Th 2c', committed: 100 },
          { seatIndex: 1, hole: 'Td 3c', committed: 100 },
        ],
      }),
      0,
    );

    const { revealed, awards } = resolveShowdown(table);

    expect(revealed.map((reveal) => reveal.seatIndex)).toEqual([0, 1]);
    expect(awards.map((award) => award.amount)).toEqual([100, 100]);
  });

  it('shows a short stack that loses the side pot and wins the main', () => {
    // Seat 1 is all in for less with the best hand: it loses nothing, but it is
    // behind seat 0 in the order, so only the winner rule puts it face up.
    const table = withAggressor(
      showdownTable({
        board: 'As Kd 9h 4c 2s',
        buttonSeat: 2,
        seats: [
          { seatIndex: 0, hole: 'Ah Qc', committed: 300 },
          { seatIndex: 1, hole: 'Ac Ad', committed: 100 },
          { seatIndex: 2, hole: '7h 8h', committed: 300 },
        ],
      }),
      0,
    );

    const { revealed, awards } = resolveShowdown(table);
    const winners = new Set(awards.map((award) => award.seatIndex));

    expect(winners.has(1)).toBe(true);
    expect(revealed.map((reveal) => reveal.seatIndex)).toContain(1);
    // Whoever wins a pot is face up; nobody wins chips from behind a mucked hand.
    for (const seatIndex of winners) {
      expect(revealed.map((reveal) => reveal.seatIndex)).toContain(seatIndex);
    }
  });

  it('shows nothing at all when everybody else folded', () => {
    const table = showdownTable({
      board: 'As Kd 9h 4c 2s',
      buttonSeat: 0,
      seats: [
        { seatIndex: 0, hole: 'Ah Kh', committed: 100 },
        { seatIndex: 1, hole: 'Qs Qd', committed: 40, status: 'folded' },
      ],
    });

    const { revealed, mucked, awards } = resolveShowdown(table);

    expect(revealed).toEqual([]);
    expect(mucked).toEqual([]);
    expect(awards).toEqual([{ seatIndex: 0, amount: 140, potIndex: 0 }]);
  });
});
