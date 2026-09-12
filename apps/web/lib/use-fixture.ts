'use client';

import { useSyncExternalStore } from 'react';
import { isFixtureMode } from './env';
import { getFixtureControls, subscribeFixtureControls } from './net/fixture-transport';
import type { FixtureControls } from './net/fixture-transport';

/**
 * Whether this page is running on fixtures.
 *
 * It depends on `window.location`, which does not exist while the page is being
 * rendered on the server — so it is read as external state with a server
 * snapshot of `false`. That is what keeps the first client render identical to
 * the server's and avoids a hydration mismatch, without a `setState` in an
 * effect to paper over it.
 */
/** Fixture mode is fixed at load; there is nothing to subscribe to. */
const neverChanges = (): (() => void) => () => undefined;

export function useFixtureMode(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => isFixtureMode(window.location.search),
    () => false,
  );
}

/** The replay controls, when a fixture transport is open. */
export function useFixtureControls(): FixtureControls | null {
  return useSyncExternalStore(subscribeFixtureControls, getFixtureControls, () => null);
}
