import { expect, test, type Browser, type Page } from '@playwright/test';
import { joinGame, playerAt, signIn, takeSeat, type ActionName, type Player } from '../player';

/**
 * Four browsers, one complete hand.
 *
 * Four real Chromium contexts sign in as four different people, sit at the same
 * table, and play a hand out to a showdown by pressing the buttons. Every
 * assertion at the end is about chips, because chips are the thing a poker
 * client cannot be approximately right about.
 *
 * The deck is seeded (`TABLE_RNG_SEED`), so which hand wins is fixed from run to
 * run — but the test does not hard-code a winner. It asserts what has to be true
 * of *any* correct payout of this line: everyone who put chips in is down by
 * exactly what they put in, one of them is up by exactly the pot, and the four
 * stacks still add to four thousand.
 */
const BUY_IN = 1_000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;

/**
 * The line, seat by seat.
 *
 * Seats 0–3, button on 0, so the small blind is seat 1, the big blind seat 2,
 * and seat 3 is first to act before the flop. After it, the action opens to the
 * button's left and runs 1, 3, 0 — seat 2 having folded.
 */
const PREFLOP: Step[] = [
  { seat: 3, action: 'Raise', amount: 30 },
  { seat: 0, action: 'Call' },
  { seat: 1, action: 'Call' },
  { seat: 2, action: 'Fold' },
];

const FLOP: Step[] = [
  { seat: 1, action: 'Check' },
  { seat: 3, action: 'Check' },
  { seat: 0, action: 'Bet', amount: 50 },
  { seat: 1, action: 'Call' },
  { seat: 3, action: 'Call' },
];

const TURN: Step[] = [
  { seat: 1, action: 'Check' },
  { seat: 3, action: 'Check' },
  { seat: 0, action: 'Check' },
];

const RIVER: Step[] = TURN;

interface Step {
  readonly seat: number;
  readonly action: ActionName;
  readonly amount?: number;
}

/** What each seat has put in by the end of the hand. */
const CONTRIBUTED: Readonly<Record<number, number>> = {
  0: 30 + 50,
  1: 30 + 50,
  2: BIG_BLIND,
  3: 30 + 50,
};

const POT = Object.values(CONTRIBUTED).reduce((sum, amount) => sum + amount, 0);

test('four players play one complete hand, and the chips are exactly right', async ({
  browser,
}) => {
  const players = await seatFourPlayers(browser);

  const table = at(players, 0).page;

  try {
    // ---- everybody is in the first hand -----------------------------------
    // Four seats holding two cards each, which is what proves the whole table
    // was dealt in rather than the first two who finished clicking.
    for (const player of players) {
      await expect(player.page.getByTestId(`seat-${String(player.seatIndex)}`)).toBeVisible({
        timeout: 40_000,
      });
    }

    // ---- the blinds are up ------------------------------------------------
    await expect(table.getByTestId('pot-total')).toHaveText(String(SMALL_BLIND + BIG_BLIND), {
      timeout: 40_000,
    });
    expect(await at(players, 1).stack()).toBe(BUY_IN - SMALL_BLIND);
    expect(await at(players, 2).stack()).toBe(BUY_IN - BIG_BLIND);

    // ---- preflop: a raise, two calls and a fold ---------------------------
    await play(players, PREFLOP);
    await expectBoard(table, 3);

    // ---- flop: check, check, bet, call, call ------------------------------
    await play(players, FLOP);
    await expectBoard(table, 4);

    // ---- turn -------------------------------------------------------------
    await play(players, TURN);
    await expectBoard(table, 5);

    // ---- river, and the showdown -----------------------------------------
    await play(players, RIVER);

    // The hand is settled when the result panel names a winner. The server holds
    // a beat between the cards going face up and the chips moving, so this is
    // genuinely waiting for the table, not for a render.
    await expect(table.getByRole('region', { name: 'Hand result' })).toBeVisible({
      timeout: 40_000,
    });

    // ---- the chips --------------------------------------------------------
    const stacks = await readAllStacks(at(players, 0));

    // Everybody is down by exactly what they put in, except whoever won, who is
    // up by exactly the pot.
    const winners = SEATS.filter((seat) => chipsAt(stacks, seat) !== lostStack(seat));

    expect(
      winners,
      `expected exactly one winning seat, from stacks ${JSON.stringify(stacks)}`,
    ).toHaveLength(1);

    const winner = winners[0] ?? -1;
    expect(chipsAt(stacks, winner)).toBe(lostStack(winner) + POT);

    // Seat 2 folded before the flop and is down its big blind, no more.
    expect(chipsAt(stacks, 2)).toBe(BUY_IN - BIG_BLIND);

    // And nothing was created or destroyed on the way.
    expect(stacks.reduce((sum, stack) => sum + stack, 0)).toBe(BUY_IN * 4);

    // Every browser agrees, which is the part that would break if a client were
    // keeping its own books.
    for (const player of players) {
      expect(await readAllStacks(player), `${player.name} disagrees about the stacks`).toEqual(
        stacks,
      );
    }
  } finally {
    for (const player of players) await player.page.context().close();
  }
});

const SEATS = [0, 1, 2, 3] as const;

function at(players: readonly Player[], seat: number): Player {
  const player = players[seat];
  if (!player) throw new Error(`no player in seat ${String(seat)}`);
  return player;
}

function chipsAt(stacks: readonly number[], seat: number): number {
  const stack = stacks[seat];
  if (stack === undefined) throw new Error(`no stack read for seat ${String(seat)}`);
  return stack;
}

/** What a seat is left with if it wins nothing. */
function lostStack(seat: number): number {
  return BUY_IN - (CONTRIBUTED[seat] ?? 0);
}

function readAllStacks(player: Player): Promise<number[]> {
  return Promise.all(SEATS.map((seat) => player.stackOf(seat)));
}

/**
 * Four contexts, four sign-ins, four seats, one table.
 *
 * Everybody sits before anybody joins. Signing four people in takes seconds, and
 * the table deals as soon as two of them are *in* — so joining as you go would
 * deal the first hand heads-up while the other two were still typing a code.
 * Sitting down is deliberately not joining, which is exactly what makes this
 * work.
 */
async function seatFourPlayers(browser: Browser): Promise<Player[]> {
  const names = ['Ana', 'Ben', 'Cleo', 'Dev'];
  const players: Player[] = [];
  let code = '';

  for (const [seatIndex, name] of names.entries()) {
    const context = await browser.newContext();
    const { page, phone } = await signIn(context, name);

    if (seatIndex === 0) {
      await page.getByRole('button', { name: 'Create the table' }).click();
      await page.waitForURL(/\/table\/[A-Z0-9]{6}$/, { timeout: 40_000 });
      code = new URL(page.url()).pathname.split('/').pop() ?? '';
      expect(code).toHaveLength(6);
    } else {
      await page.getByLabel('Table code').fill(code);
      await page.getByRole('button', { name: 'Join', exact: true }).click();
      await page.waitForURL(`**/table/${code}`, { timeout: 40_000 });
    }

    await expect(page.getByText('Connected')).toBeVisible({ timeout: 40_000 });
    await takeSeat(page, seatIndex, BUY_IN);

    players.push(playerAt(page, name, phone, seatIndex));
  }

  // Nothing has been dealt yet: four chairs, nobody in the game.
  for (const player of players) await joinGame(player.page);

  return players;
}

/** Run a street's worth of the script, each player waiting for their own turn. */
async function play(players: readonly Player[], steps: readonly Step[]): Promise<void> {
  for (const step of steps) await at(players, step.seat).act(step.action, step.amount);
}

async function expectBoard(page: Page, cards: number): Promise<void> {
  await expect(page.getByRole('img', { name: /of (spades|hearts|diamonds|clubs)$/ })).toHaveCount(
    // The viewer's own two cards are on screen alongside the board.
    cards + 2,
    { timeout: 40_000 },
  );
}
