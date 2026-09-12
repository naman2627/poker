import { expect, test, type Browser } from '@playwright/test';
import { joinGame, playerAt, signIn, takeSeat, type Player } from '../player';

/**
 * The definition of done: four tabs, twenty hands in a row, nothing stuck.
 *
 * Nobody drives this one to a script. A loop finds whoever the table has put on
 * the clock, presses the free option — check if it is free, call if it is not —
 * and moves on. That is the point: over twenty hands the button goes all the way
 * round twice, side pots form, players bust and rebuy, and no part of it is
 * arranged.
 *
 * What it watches for is the three failure modes worth naming:
 *
 *   desync   — after every hand, all four browsers are asked for all four
 *              stacks, and every answer has to match every other one
 *   lost chips — those stacks have to add up to what sat down, hand after hand
 *   a stuck clock — no hand may be advanced by the action timer running out;
 *              if the log ever says somebody ran out of time, a click went
 *              missing and the table was waiting on nobody
 */
const BUY_IN = 1_000;
const PLAYERS = 4;
const HANDS = 20;
const TOTAL_CHIPS = BUY_IN * PLAYERS;

test.describe('twenty consecutive hands', () => {
  test.setTimeout(600_000);

  test('four players, twenty hands, no desync and no stuck clock', async ({ browser }) => {
    const players = await seatEveryone(browser);
    const table = players[0]?.page;
    if (!table) throw new Error('no players');

    try {
      for (let hand = 1; hand <= HANDS; hand += 1) {
        await expect(table.getByTestId('hand-number')).toHaveText(String(hand), {
          timeout: 60_000,
        });

        await playOneHand(players);

        // Every browser is asked separately, so a client keeping its own books
        // would be caught here rather than agreeing with itself.
        const views = await Promise.all(players.map(readStacks));
        const first = views[0];
        if (!first) throw new Error('no view');

        for (const [index, view] of views.entries()) {
          expect(
            view,
            `${players[index]?.name ?? '?'} disagrees after hand ${String(hand)}`,
          ).toEqual(first);
        }

        const inPlay = first.reduce((sum, stack) => sum + stack, 0);
        expect(inPlay, `chips went missing in hand ${String(hand)}`).toBe(TOTAL_CHIPS);

        // Anybody who busted buys back in, so the table keeps its four players
        // and the run keeps meaning something.
        await rebuyBustedPlayers(players, first);
      }

      // Nothing was ever decided by a clock running out. A single one of these
      // means a client stopped answering and the table carried on without it.
      for (const player of players) {
        await expect(player.page.getByText(/ran out of time/)).toHaveCount(0);
      }

      // And after all that, four connected browsers still watching one table.
      for (const player of players) {
        await expect(player.page.getByText('Connected')).toBeVisible();
      }
    } finally {
      for (const player of players) await player.page.context().close();
    }
  });
});

/**
 * Play the hand in front of us, whoever is in it.
 *
 * Checks when checking is free and calls when it is not, which never folds and
 * so takes every hand as far as it can go. It follows the table rather than
 * leading it: the loop asks who is on the clock and waits if the answer is
 * nobody, because between streets and during the showdown beat the answer *is*
 * nobody.
 */
async function playOneHand(players: readonly Player[]): Promise<void> {
  const table = players[0]?.page;
  if (!table) throw new Error('no players');

  const handNumber = await table.getByTestId('hand-number').innerText();

  for (let step = 0; step < 200; step += 1) {
    // The hand is over when the table has moved on to the next one, or has
    // settled and is waiting to.
    const now = await table.getByTestId('hand-number').innerText();
    const phase = await table.getByTestId('phase').innerText();
    if (now !== handNumber) return;
    if (phase === 'hand end') return;

    const actor = await whoseTurn(players);
    if (!actor) {
      await table.waitForTimeout(100);
      continue;
    }

    const canCheck = await actor.page.getByTestId('action-check').isVisible();
    await actor.act(canCheck ? 'Check' : 'Call');
  }

  throw new Error(`hand ${handNumber} did not finish within 200 steps`);
}

async function whoseTurn(players: readonly Player[]): Promise<Player | null> {
  for (const player of players) {
    if (await player.onTheClock()) return player;
  }
  return null;
}

function readStacks(player: Player): Promise<number[]> {
  return Promise.all(Array.from({ length: PLAYERS }, (_unused, seat) => player.stackOf(seat)));
}

async function rebuyBustedPlayers(
  players: readonly Player[],
  stacks: readonly number[],
): Promise<void> {
  for (const player of players) {
    if (stacks[player.seatIndex] !== 0) continue;

    const rebuy = player.page.getByRole('button', { name: 'Rebuy' });
    if (!(await rebuy.isVisible())) continue;

    await rebuy.click();
    await player.page.getByRole('button', { name: /^Add / }).click();
    await joinGame(player.page);
  }
}

async function seatEveryone(browser: Browser): Promise<Player[]> {
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
    } else {
      await page.getByLabel('Table code').fill(code);
      await page.getByRole('button', { name: 'Join', exact: true }).click();
      await page.waitForURL(`**/table/${code}`, { timeout: 40_000 });
    }

    await expect(page.getByText('Connected')).toBeVisible({ timeout: 40_000 });
    await takeSeat(page, seatIndex, BUY_IN);
    players.push(playerAt(page, name, phone, seatIndex));
  }

  for (const player of players) await joinGame(player.page);
  return players;
}
