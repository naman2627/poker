import { describe, expect, it } from 'vitest';
import {
  SERVER_EVENTS,
  type PublicTableState,
  type StatePatchPayload,
  type StateSyncPayload,
} from '@poker/shared';
import { SCRIPT } from '../fixtures/scripted-hand';
import { applyPatch, potTotal } from '../lib/store/patch';

/**
 * The recording is written by hand, so it is worth checking that it says the
 * same thing twice.
 *
 * Replaying the patches on top of the first whole state has to land on the same
 * numbers as the whole states the recording sends later. If somebody edits a
 * stack in one place and forgets the other, these fail — which is the only thing
 * standing between a hand-written fixture and a table that quietly does not add
 * up.
 */
/** Every point a whole state arrived on top of a patched one, and both views. */
interface Checkpoint {
  readonly version: number;
  readonly fromPatches: Record<number, number>;
  readonly fromSync: Record<number, number>;
}

interface Replay {
  readonly state: PublicTableState;
  readonly awarded: number;
  readonly syncs: readonly PublicTableState[];
  readonly checkpoints: readonly Checkpoint[];
}

function replay(): Replay {
  let state: PublicTableState | null = null;
  let awarded = 0;
  let version = -1;
  const syncs: PublicTableState[] = [];
  const checkpoints: Checkpoint[] = [];
  let lastSyncVersion = -1;

  for (const frame of SCRIPT) {
    if (frame.event === SERVER_EVENTS.stateSync) {
      const payload = frame.payload as StateSyncPayload;
      if (state !== null) syncs.push(payload.state);

      // Only a sync that lands on top of patched-forward state is a comparison
      // worth making. The one that opens a hand arrives *before* the patch
      // describing the same change, so there is nothing yet to compare it to.
      if (state !== null && version > lastSyncVersion) {
        checkpoints.push({
          version: payload.version,
          fromPatches: stacks(state),
          fromSync: stacks(payload.state),
        });
      }

      state = payload.state;
      version = payload.version;
      lastSyncVersion = payload.version;
      awarded = 0;
      continue;
    }

    if (frame.event !== SERVER_EVENTS.statePatch) continue;
    const payload = frame.payload as StatePatchPayload;
    if (state === null) throw new Error('the recording patches before it syncs');

    // The store skips a patch whose version a sync has already covered; the
    // replay has to behave the same way or it double-counts.
    if (payload.version <= version) continue;

    const applied = applyPatch(state, awarded, payload.events);
    expect(applied.resyncNeeded).toBe(false);
    state = applied.state;
    awarded = applied.awarded;
    version = payload.version;
  }

  if (state === null) throw new Error('the recording never sends a state');
  return { state, awarded, syncs, checkpoints };
}

describe('the recorded hand', () => {
  it('never sends a version that goes backwards', () => {
    let previous = -1;

    for (const frame of SCRIPT) {
      const payload = frame.payload as { version?: number };
      if (typeof payload.version !== 'number') continue;
      expect(payload.version).toBeGreaterThanOrEqual(previous);
      previous = payload.version;
    }
  });

  it('never skips a version', () => {
    const versions = SCRIPT.map((frame) => (frame.payload as { version?: number }).version).filter(
      (version): version is number => typeof version === 'number',
    );

    for (let i = 1; i < versions.length; i += 1) {
      const step = (versions[i] ?? 0) - (versions[i - 1] ?? 0);
      expect(step === 0 || step === 1).toBe(true);
    }
  });

  it('agrees with itself: the patches reach the stacks the whole states claim', () => {
    // This is the assertion that makes a hand-written recording trustworthy. At
    // every point the script sends a whole state, the stacks it claims have to
    // match the ones the patches before it produced. Edit one and forget the
    // other, and this fails.
    const { checkpoints } = replay();

    expect(checkpoints.length).toBeGreaterThan(3);
    for (const checkpoint of checkpoints) {
      expect({ version: checkpoint.version, stacks: checkpoint.fromPatches }).toEqual({
        version: checkpoint.version,
        stacks: checkpoint.fromSync,
      });
    }
  });

  it('ends with the stacks the hand was worked out to produce', () => {
    const { state } = replay();

    expect(state.phase).toBe('hand_end');
    expect(state.board).toHaveLength(5);
    expect(stacks(state)).toEqual({ 0: 620, 1: 990, 2: 505, 4: 1050, 6: 1000, 7: 1000 });
  });

  it('conserves chips: nothing is created or destroyed across the hand', () => {
    const { syncs } = replay();
    expect(syncs.length).toBeGreaterThan(0);

    const totals = syncs.map((state) =>
      state.seats.reduce(
        (sum, seat) => sum + (seat?.stack ?? 0) + (seat?.committedThisHand ?? 0),
        0,
      ),
    );

    // Every whole state the recording sends adds up to the same 5165 chips that
    // sat down.
    for (const total of totals) expect(total).toBe(5165);
  });

  it('closes the pot out when the hand settles', () => {
    const { state, awarded } = replay();
    expect(potTotal(state, awarded)).toBe(0);
  });

  it('pays out exactly what was put in', () => {
    const awards = SCRIPT.flatMap((frame) => {
      if (frame.event !== SERVER_EVENTS.statePatch) return [];
      return (frame.payload as StatePatchPayload).events.filter(
        (event) => event.type === 'POT_AWARDED',
      );
    });

    const paid = awards.reduce(
      (sum, event) => sum + (typeof event.amount === 'number' ? event.amount : 0),
      0,
    );

    // 30 + 10 + 30 + 30 preflop, 150 + 135 + 150 on the flop, 200 + 200 on the turn.
    expect(paid).toBe(935);
  });
});

function stacks(state: PublicTableState): Record<number, number> {
  const result: Record<number, number> = {};
  for (const seat of state.seats) if (seat) result[seat.seatIndex] = seat.stack;
  return result;
}
