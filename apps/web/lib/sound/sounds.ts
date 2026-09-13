import type { TableEvent } from '@poker/shared';

/**
 * What the table sounds like, as data.
 *
 * Nothing in this file touches the Web Audio API — it is the *score*, and
 * `engine.ts` is the instrument. Keeping them apart is what lets the decisions
 * that actually matter (which event makes which noise, and whether it is
 * allowed to play at all) be tested in node with no audio hardware and no DOM.
 *
 * There are no audio files anywhere in this project. Six sounds at a few dozen
 * bytes of arithmetic each beat six network requests and a licensing question,
 * and a synthesised tone can be tuned by changing a number rather than by
 * opening an editor.
 */

export type SoundName = 'deal' | 'chip' | 'check' | 'fold' | 'turn' | 'win';

/**
 * One oscillator, with an envelope.
 *
 * `to` glides the pitch across the life of the voice; leaving it out holds a
 * steady note. Everything is relative to the moment the sound starts, so a
 * multi-voice sound is just a list with different `at` offsets.
 */
export interface Voice {
  readonly type: OscillatorType;
  /** Hertz at the start of the voice. */
  readonly from: number;
  /** Hertz at the end, when the voice should bend. */
  readonly to?: number;
  /** Seconds after the sound begins. */
  readonly at: number;
  readonly dur: number;
  /** Peak of the envelope, 0..1, before the master gain. */
  readonly gain: number;
}

/**
 * A burst of filtered noise — the only thing here that is not a tone.
 *
 * A card leaving a deck is broadband and pitchless; an oscillator cannot do it
 * and a band-passed noise burst can.
 */
export interface NoiseBurst {
  readonly at: number;
  readonly dur: number;
  readonly gain: number;
  /** Centre of the band-pass, in hertz. */
  readonly centre: number;
  readonly q: number;
}

export interface SoundSpec {
  readonly voices: readonly Voice[];
  readonly noise: readonly NoiseBurst[];
}

/**
 * Everything is quiet on purpose.
 *
 * These play over a game people leave open for an hour, often beside something
 * else they are listening to. A sound that announces itself is a sound that
 * gets switched off — and the one that matters most (`turn`) is the one that
 * has to survive being left on.
 */
export const MASTER_GAIN = 0.35;

export const SOUNDS: Readonly<Record<SoundName, SoundSpec>> = {
  /** A card off the deck: one short, bright, pitchless flick. */
  deal: {
    voices: [],
    noise: [{ at: 0, dur: 0.055, gain: 0.5, centre: 2_200, q: 0.9 }],
  },

  /**
   * Chips into the middle. Two clicks a hair apart, because one chip landing on
   * another is never a single sound.
   */
  chip: {
    voices: [
      { type: 'triangle', from: 2_400, to: 1_900, at: 0, dur: 0.035, gain: 0.35 },
      { type: 'triangle', from: 3_100, to: 2_500, at: 0.045, dur: 0.03, gain: 0.25 },
    ],
    noise: [{ at: 0, dur: 0.02, gain: 0.18, centre: 4_000, q: 1.2 }],
  },

  /** Knuckles on the felt: low, blunt, gone immediately. */
  check: {
    voices: [{ type: 'sine', from: 150, to: 85, at: 0, dur: 0.11, gain: 0.5 }],
    noise: [{ at: 0, dur: 0.03, gain: 0.2, centre: 320, q: 0.7 }],
  },

  /** Cards pushed away — a short fall, softer than a check. */
  fold: {
    voices: [{ type: 'sine', from: 420, to: 170, at: 0, dur: 0.17, gain: 0.22 }],
    noise: [{ at: 0.02, dur: 0.09, gain: 0.12, centre: 1_400, q: 0.8 }],
  },

  /**
   * Your turn. Two rising notes — the one sound in here that has to carry from
   * another room, and the only one people keep on by itself.
   */
  turn: {
    voices: [
      { type: 'sine', from: 880, at: 0, dur: 0.15, gain: 0.4 },
      { type: 'sine', from: 1_320, at: 0.13, dur: 0.22, gain: 0.36 },
    ],
    noise: [],
  },

  /** A small major arpeggio. Pleased, not triumphant — it happens a lot. */
  win: {
    voices: [
      { type: 'triangle', from: 523.25, at: 0, dur: 0.16, gain: 0.3 },
      { type: 'triangle', from: 659.25, at: 0.1, dur: 0.16, gain: 0.3 },
      { type: 'triangle', from: 783.99, at: 0.2, dur: 0.3, gain: 0.32 },
    ],
    noise: [],
  },
};

/** How long a sound runs, so the engine knows when to let go of its nodes. */
export function durationOf(spec: SoundSpec): number {
  const ends = [
    ...spec.voices.map((voice) => voice.at + voice.dur),
    ...spec.noise.map((burst) => burst.at + burst.dur),
  ];
  return ends.length === 0 ? 0 : Math.max(...ends);
}

/* ------------------------------------------------------------------ *
 * What makes a noise                                                  *
 * ------------------------------------------------------------------ */

export interface SoundPrefs {
  /** The five table sounds. Off by default. */
  readonly enabled: boolean;
  /** The your-turn chime. Its own switch — see below. Off by default. */
  readonly turnChime: boolean;
}

export const SILENT: SoundPrefs = { enabled: false, turnChime: false };

/**
 * THE TWO SWITCHES.
 *
 * `turnChime` is deliberately **not** gated behind `enabled`. It is the one
 * sound that makes a slow game bearable — it is what lets somebody put the tab
 * behind their work and still play — and plenty of people want exactly that and
 * nothing else. Making it a child of the master switch would force them to take
 * five sounds they do not want in order to get the one they do.
 *
 * So: the master switch governs the table. The chime governs itself.
 */
export function shouldPlay(name: SoundName, prefs: SoundPrefs): boolean {
  return name === 'turn' ? prefs.turnChime : prefs.enabled;
}

/**
 * The sound an engine event makes, if any.
 *
 * `viewerSeatIndex` is here for exactly one reason: `win` should be the sound of
 * *you* winning. A chime every time somebody else drags a pot would be a noise
 * the table makes at you rather than a thing that happened to you, and it would
 * be the first sound anybody turned off.
 *
 * The your-turn chime is not decided here — it comes from the server's
 * `action:prompt`, which is addressed to one player, rather than from the public
 * event stream. See `use-table-sounds.ts`.
 */
export function soundForEvent(event: TableEvent, viewerSeatIndex: number | null): SoundName | null {
  switch (event.type) {
    case 'HOLE_CARDS_DEALT':
    case 'BOARD_DEALT':
      return 'deal';

    case 'BLIND_POSTED':
      return 'chip';

    case 'PLAYER_ACTED': {
      const action = typeof event.action === 'string' ? event.action : '';
      if (action === 'CHECK') return 'check';
      if (action === 'FOLD') return 'fold';
      // CALL, BET, RAISE, ALL_IN all move chips.
      return 'chip';
    }

    case 'ACTION_TIMED_OUT':
      return event.appliedAction === 'FOLD' ? 'fold' : 'check';

    case 'POT_AWARDED':
      return viewerSeatIndex !== null && event.seatIndex === viewerSeatIndex ? 'win' : null;

    default:
      return null;
  }
}

/**
 * One patch's worth of sound.
 *
 * A street can deal three cards and pay two pots in a single patch, and playing
 * every one of them would be a rattle rather than a table. So each *kind* of
 * sound fires at most once per patch, in the order the events arrived.
 */
export function soundsForPatch(
  events: readonly TableEvent[],
  viewerSeatIndex: number | null,
): SoundName[] {
  const played = new Set<SoundName>();
  const order: SoundName[] = [];

  for (const event of events) {
    const name = soundForEvent(event, viewerSeatIndex);
    if (name === null || played.has(name)) continue;
    played.add(name);
    order.push(name);
  }

  return order;
}
