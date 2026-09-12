/**
 * The one place in the engine that is allowed to touch a Node built-in.
 *
 * Everything else in this package takes an `Rng` as an argument. That is what
 * makes shuffles reproducible in tests and auditable in production, and it is
 * why `Math.random` is banned repo-wide (see CLAUDE.md).
 */
import { createHash, randomInt } from 'node:crypto';

export interface Rng {
  /**
   * A uniformly distributed integer in [0, maxExclusive).
   * Implementations must be free of modulo bias.
   */
  int(maxExclusive: number): number;
}

/** Cryptographically secure Rng. This is what the server injects in production. */
export function createCryptoRng(): Rng {
  return createRngFrom((maxExclusive) => randomInt(maxExclusive));
}

/** Short alias for {@link createCryptoRng}. */
export function cryptoRng(): Rng {
  return createCryptoRng();
}

/**
 * Wraps any source of uniform integers so tests can inject a scripted or
 * seeded sequence without depending on node:crypto.
 */
export function createRngFrom(nextInt: (maxExclusive: number) => number): Rng {
  return {
    int(maxExclusive: number): number {
      assertValidBound(maxExclusive);
      const value = nextInt(maxExclusive);
      if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
        throw new RangeError(`Rng produced ${String(value)}, outside [0, ${maxExclusive})`);
      }
      return value;
    },
  };
}

/**
 * The deck a hand was dealt from, derived from that hand's seed.
 *
 * This is the shuffle behind the fairness commitment, so two properties matter
 * more than anything else about it.
 *
 * **It uses the whole seed.** `seededRng` below folds its input down to
 * thirty-two bits, which is fine for a test and useless here: a commitment is
 * only worth something if nobody can work out the deck before the seed is
 * published, and two-to-the-thirty-two SHA-256 guesses is an afternoon. This
 * takes all 256 bits and never narrows them.
 *
 * **It can never change.** Every hand ever recorded is verified by re-running
 * exactly this function. SHA-256 in counter mode, big-endian, four bytes a draw,
 * rejection-sampled — pinned by `test/seed-rng.test.ts`, which holds the decks
 * two fixed seeds produce. Changing any of it retroactively makes every stored
 * hand unverifiable.
 */
export function createSeedRng(seedHex: string): Rng {
  const seed = bytesFromHex(seedHex);
  if (seed.length === 0) {
    throw new RangeError('a deck seed cannot be empty');
  }

  let counter = 0;
  let pool = new Uint8Array(0);
  let offset = 0;

  /** SHA-256(seed || counter), block after block, as one byte stream. */
  const nextBytes = (count: number): Uint8Array => {
    while (pool.length - offset < count) {
      const suffix = new Uint8Array(4);
      new DataView(suffix.buffer).setUint32(0, counter, false);
      counter += 1;

      const block = new Uint8Array(createHash('sha256').update(seed).update(suffix).digest());
      const carried = pool.subarray(offset);
      const grown = new Uint8Array(carried.length + block.length);
      grown.set(carried, 0);
      grown.set(block, carried.length);
      pool = grown;
      offset = 0;
    }

    const out = pool.subarray(offset, offset + count);
    offset += count;
    return out;
  };

  return createRngFrom((maxExclusive) => {
    if (maxExclusive === 1) return 0;

    // Rejection sampling: discard the tail that would make some residues more
    // likely than others, which is what modulo alone would do.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const bytes = nextBytes(4);
      const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
      if (value < limit) return value % maxExclusive;
    }
  });
}

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new RangeError('a deck seed must be an even-length hex string');
  }

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Deterministic Rng for tests: the same seed always yields the same sequence,
 * so a hand can be replayed card for card. Never use this in production — it is
 * seeded from a string, folded to thirty-two bits, and trivially predictable.
 * For a deck anybody is going to audit, use {@link createSeedRng}.
 */
export function seededRng(seed: string): Rng {
  const nextUint32 = mulberry32(hashSeed(seed));
  return createRngFrom((maxExclusive) => {
    if (maxExclusive > 0x1_0000_0000) {
      throw new RangeError(`seededRng supports bounds up to 2^32, got ${String(maxExclusive)}`);
    }
    // Rejection sampling: discard the tail that would make some residues more
    // likely than others, which is what modulo alone would do.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let value = nextUint32();
    while (value >= limit) value = nextUint32();
    return value % maxExclusive;
  });
}

function assertValidBound(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
    throw new RangeError(`maxExclusive must be a safe integer >= 1, got ${String(maxExclusive)}`);
  }
}

/** xmur3: string -> 32-bit seed. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: 32-bit state, uniform 32-bit output. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
