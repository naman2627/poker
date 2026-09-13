import { EMOTES, type Emote } from '@poker/shared';

/**
 * How a reaction is drawn and what it is called.
 *
 * The wire carries an id; this is the only place that turns one into a glyph.
 * That split is what lets the six be re-drawn — or read aloud by a screen
 * reader, which is what `label` is for — without the server knowing anything
 * about it.
 */
export interface EmoteLook {
  readonly id: Emote;
  readonly glyph: string;
  /** Spoken, and used as the button's accessible name. */
  readonly label: string;
}

export const EMOTE_LOOKS: readonly EmoteLook[] = [
  { id: 'clap', glyph: '👏', label: 'Nice hand' },
  { id: 'laugh', glyph: '😂', label: 'Laughing' },
  { id: 'shock', glyph: '😱', label: 'Shocked' },
  { id: 'think', glyph: '🤔', label: 'Thinking' },
  { id: 'salute', glyph: '🫡', label: 'Respect' },
  { id: 'salt', glyph: '🧂', label: 'Salty' },
];

const BY_ID = new Map(EMOTE_LOOKS.map((look) => [look.id, look]));

export function emoteLook(id: Emote): EmoteLook {
  const look = BY_ID.get(id);
  // Every id in `EMOTES` has a look; this keeps the return type honest without
  // a non-null assertion.
  return look ?? { id, glyph: '•', label: id };
}

/** The six the server accepts, in the order they are offered. */
export function everyEmote(): readonly Emote[] {
  return EMOTES;
}

/**
 * How long a reaction stays on the felt.
 *
 * Long enough to notice from across the table, short enough that three people
 * reacting at once does not bury the seat they are reacting to. The server's
 * cooldown is longer, so a seat can never hold two of its own at the same time.
 */
export const EMOTE_LIFETIME_MS = 2_600;

/** One reaction, on its way out. */
export interface FloatingEmote {
  /** Unique per arrival, so two identical reactions animate separately. */
  readonly key: string;
  readonly seatIndex: number;
  readonly emote: Emote;
}
