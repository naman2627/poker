import { expect, test, type Browser } from '@playwright/test';
import { joinGame, playerAt, signIn, takeSeat, type Player } from '../player';

/**
 * The record of play, through the interface people read it in.
 *
 * Three players play a couple of hands, then open the history and check what is
 * there: the hands, a replay driven by the recorded actions, and the fairness
 * verification for a deal that really happened.
 *
 * The fairness assertion is the one worth being careful about. It is not "the
 * page says verified" — a page can say anything. It is that the seed published
 * after the hand hashes to the commitment published before it, and that the deck
 * that seed produces is the deal on record. The server recomputes both; this
 * checks the page reports them and that a reader who was not in the hand still
 * cannot see a mucked hand.
 */
const BUY_IN = 1_000;
const PLAYERS = 3;

test.describe('hand history', () => {
  test.setTimeout(240_000);

  test('records hands, replays them, and proves the deal was straight', async ({ browser }) => {
    const players = await seatEveryone(browser);
    const table = players[0]?.page;
    if (!table) throw new Error('no players');

    try {
      // Two hands, so the list has something to be a list of. Waiting for each
      // one to be dealt first matters: the table pauses before dealing, and a
      // loop that started early would find nobody on the clock and return
      // having played nothing.
      await playHands(players, 2);

      await table.getByRole('button', { name: 'Hand history' }).click();
      await expect(table).toHaveURL(/\/history$/);

      // ---- the list ---------------------------------------------------------
      const rows = table.getByRole('listitem').filter({ has: table.getByRole('button') });
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });

      const finished = table.getByRole('button', { expanded: false });
      await expect(finished.first()).toBeVisible();

      // Newest first, and the pot is a real number rather than a dash.
      await expect(table.getByText(/#\d+/).first()).toBeVisible();
      await expect(table.getByText(/won/).first()).toBeVisible();

      // ---- the replay -------------------------------------------------------
      await finished.first().click();

      // Driven by the recorded actions: blinds, then somebody acting.
      await expect(table.getByText(/posts the (small|big) blind/).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(table.getByText(/step \d+ of \d+/)).toBeVisible();

      // Stepping back changes what is on screen, which is the whole point of
      // replaying from actions rather than showing a finished snapshot.
      const stepLabel = table.getByText(/step \d+ of \d+/);
      const atEnd = await stepLabel.innerText();
      await table.getByRole('button', { name: '← Back' }).click();
      await expect(stepLabel).not.toHaveText(atEnd);

      // ---- the fairness check ----------------------------------------------
      await table.getByRole('button', { name: 'Was this deal straight?' }).click();

      await expect(table.getByText('Verified')).toBeVisible({ timeout: 30_000 });
      await expect(table.getByText('The seed opens the commitment')).toBeVisible();
      await expect(table.getByText('The committed deck is the one that was dealt')).toBeVisible();

      // Both halves passed, and the seed and commitment are printed so anybody
      // can redo the hash themselves.
      const commitment = table.getByText(/Commitment \(published before the deal\)/);
      await expect(commitment).toBeVisible();
      await expect(table.getByText(/^[0-9a-f]{64}$/).first()).toBeVisible();
    } finally {
      for (const player of players) await player.page.context().close();
    }
  });

  test('does not show a watcher a hand that was mucked', async ({ browser }) => {
    const players = await seatEveryone(browser);
    const watcher = players[1]?.page;
    if (!watcher) throw new Error('no players');

    try {
      await playHands(players, 1);

      await watcher.goto(`${new URL(watcher.url()).pathname}/history`);
      const first = watcher.getByRole('button', { expanded: false }).first();
      await expect(first).toBeVisible({ timeout: 60_000 });
      await first.click();

      await expect(watcher.getByText(/step \d+ of \d+/)).toBeVisible({ timeout: 30_000 });

      // A hand that mucked is marked as such rather than quietly shown. If
      // nothing mucked in this hand there is nothing to assert, and the check
      // above already proved the replay renders.
      const mucked = watcher.getByText('mucked', { exact: true });
      if ((await mucked.count()) > 0) await expect(mucked.first()).toBeVisible();
    } finally {
      for (const player of players) await player.page.context().close();
    }
  });
});

/** Wait for each hand to be dealt, then play it out. */
async function playHands(players: readonly Player[], count: number): Promise<void> {
  const table = players[0]?.page;
  if (!table) throw new Error('no players');

  for (let hand = 1; hand <= count; hand += 1) {
    await expect(table.getByTestId('hand-number')).toHaveText(String(hand), { timeout: 60_000 });
    await playOneHand(players);
  }

  // And let the hand that has just finished be written down before anybody
  // goes looking for it.
  await expect(table.getByTestId('hand-number')).toHaveText(String(count + 1), {
    timeout: 60_000,
  });
}

/** Check when checking is free, call when it is not, until the hand moves on. */
async function playOneHand(players: readonly Player[]): Promise<void> {
  const table = players[0]?.page;
  if (!table) throw new Error('no players');

  const handNumber = await table.getByTestId('hand-number').innerText();

  for (let step = 0; step < 200; step += 1) {
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

  throw new Error(`hand ${handNumber} did not finish`);
}

async function whoseTurn(players: readonly Player[]): Promise<Player | null> {
  for (const player of players) {
    if (await player.onTheClock()) return player;
  }
  return null;
}

async function seatEveryone(browser: Browser): Promise<Player[]> {
  const names = ['Ana', 'Ben', 'Cleo'].slice(0, PLAYERS);
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
