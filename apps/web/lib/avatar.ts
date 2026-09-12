/**
 * Avatars are drawn from a seed string, never rolled.
 *
 * `Math.random` is banned repo-wide (CLAUDE.md §3), and there is a better reason
 * than the rule here: the same player must look the same to everybody at the
 * table, on every device, after every reload. A seed and a hash give that for
 * free, with nothing to store but a short string.
 */
export const AVATAR_SEEDS = [
  'ace-of-spades',
  'river-rat',
  'blue-chip',
  'dead-money',
  'cutoff',
  'nut-flush',
  'small-blind',
  'hijack',
  'pocket-rockets',
  'gutshot',
  'the-button',
  'cold-call',
] as const;

/** FNV-1a: small, stable across engines, and not pretending to be a hash. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export interface AvatarLook {
  readonly background: string;
  readonly foreground: string;
  /** 0..3, picking one of four background shapes. */
  readonly shape: number;
}

export function avatarLook(seed: string | null): AvatarLook {
  const value = hash(seed ?? 'anonymous');
  const hue = value % 360;
  const shape = (value >>> 9) % 4;

  return {
    background: `oklch(0.42 0.11 ${String(hue)})`,
    foreground: `oklch(0.88 0.09 ${String((hue + 40) % 360)})`,
    shape,
  };
}
