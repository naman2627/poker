import { expect, type BrowserContext, type Page } from '@playwright/test';
import { lastOtpCodeFor } from './servers';

/**
 * One player, in their own browser.
 *
 * Everything here goes through the interface a person would use: type a phone
 * number, type the code, pick a name, take a seat, press Fold. Nothing reaches
 * around the UI into the store or the socket, because a test that did would stop
 * proving that the buttons are wired to anything.
 */
export type ActionName = 'Fold' | 'Check' | 'Call' | 'Bet' | 'Raise';

export interface Player {
  readonly name: string;
  readonly phone: string;
  readonly page: Page;
  readonly seatIndex: number;
  /** What a given seat's chips read, from this player's own screen. */
  stackOf(seatIndex: number): Promise<number>;
  stack(): Promise<number>;
  /** Waits for this player to be on the clock, then presses one of the buttons. */
  act(action: ActionName, amount?: number): Promise<void>;
  onTheClock(): Promise<boolean>;
}

let nextPhone = 5_000;

/** Phone, code, name — the whole sign-up, through the screens. */
export async function signIn(
  context: BrowserContext,
  name: string,
): Promise<{ page: Page; phone: string }> {
  nextPhone += 1;
  const phone = `+1415555${String(nextPhone)}`;

  const page = await context.newPage();
  await page.goto('/');

  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send me a code' }).click();

  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();

  // The six boxes spread a pasted code, so one fill is the whole thing, and the
  // sixth digit submits on its own.
  await page.getByLabel('Digit 1 of 6').fill(await waitForOtp(phone));

  await expect(page.getByRole('heading', { name: 'How should we call you?' })).toBeVisible();
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Continue to the lobby' }).click();

  await expect(page.getByRole('heading', { name: 'Deal a new table' })).toBeVisible();
  return { page, phone };
}

/**
 * The code the server printed, once it has printed it.
 *
 * Written by another process, so this polls rather than assuming the line has
 * already been flushed.
 */
async function waitForOtp(phone: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const code = lastOtpCodeFor(phone);
    if (code !== null) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`no one-time code was printed for ${phone} within ${String(timeoutMs)}ms`);
}

const TEST_IDS: Readonly<Record<Exclude<ActionName, 'Bet' | 'Raise'>, string>> = {
  Fold: 'action-fold',
  Check: 'action-check',
  Call: 'action-call',
};

export function playerAt(page: Page, name: string, phone: string, seatIndex: number): Player {
  const bar = page.getByRole('region', { name: 'Your action' });

  return {
    name,
    phone,
    seatIndex,
    page,

    stackOf: (index) => readChips(page, `seat-${String(index)}-stack`),
    stack: () => readChips(page, `seat-${String(seatIndex)}-stack`),

    onTheClock: () => bar.isVisible(),

    async act(action, amount): Promise<void> {
      // The bar only exists while this player is on the clock, so waiting for it
      // is waiting for the turn.
      await expect(bar).toBeVisible({ timeout: 40_000 });

      if (action === 'Bet' || action === 'Raise') {
        await page.getByTestId('action-raise').click();
        if (amount !== undefined) await page.getByRole('slider').fill(String(amount));
        await page.getByTestId('confirm-raise').click();
      } else {
        await page.getByTestId(TEST_IDS[action]).click();
      }

      // The bar disables itself on click and disappears when the server has
      // moved the action on. Waiting for that is what keeps the script in step
      // with the table rather than racing it.
      await expect(bar).toBeHidden({ timeout: 40_000 });
    },
  };
}

async function readChips(page: Page, testId: string): Promise<number> {
  const text = await page.getByTestId(testId).innerText({ timeout: 20_000 });
  return Number(text.replace(/[^0-9]/g, ''));
}

/**
 * Take a chair.
 *
 * Sitting down does not join the game — the seat is dealt out until its player
 * says otherwise. That is what lets four people arrive one at a time and still
 * all be in the same first hand: everybody sits, and then everybody joins.
 */
export async function takeSeat(page: Page, seatIndex: number, buyIn: number): Promise<void> {
  await page.getByLabel('Buy in for').fill(String(buyIn));
  await page.getByRole('button', { name: `Seat ${String(seatIndex + 1)}`, exact: true }).click();

  await expect(page.getByRole('button', { name: /I'm in|Deal me in/ })).toBeVisible({
    timeout: 20_000,
  });
}

/** "Deal me in." From here the table deals to this seat, hand after hand. */
export async function joinGame(page: Page): Promise<void> {
  const joinButton = page.getByRole('button', { name: /I'm in|Deal me in/ });
  await expect(joinButton).toBeEnabled({ timeout: 20_000 });
  await joinButton.click();
}
