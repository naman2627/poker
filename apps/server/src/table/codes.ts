import { TABLE_CODE_ALPHABET, TABLE_CODE_LENGTH } from '@poker/shared';
import type { Rng } from '@poker/engine';

/**
 * Six characters a person can read down a phone line: no O or 0, no I or 1.
 *
 * The randomness is injected for the same reason the deck's is — a test that
 * wants a predictable code can have one, and nothing in this repo reaches for
 * `Math.random`.
 */
export function generateTableCode(rng: Rng): string {
  let code = '';
  for (let i = 0; i < TABLE_CODE_LENGTH; i += 1) {
    code += TABLE_CODE_ALPHABET[rng.int(TABLE_CODE_ALPHABET.length)] ?? 'A';
  }
  return code;
}

/** A code no table is using yet. */
export function generateUniqueTableCode(rng: Rng, taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const code = generateTableCode(rng);
    if (!taken(code)) return code;
  }
  throw new Error('could not find a free table code');
}
