import { describe, expect, it } from 'vitest';
import { createCryptoRng, createRngFrom, seededRng } from '../src/rng';

describe('createCryptoRng', () => {
  it('stays inside [0, maxExclusive)', () => {
    const rng = createCryptoRng();
    for (let i = 0; i < 5_000; i += 1) {
      const value = rng.int(52);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(52);
    }
  });

  it('always returns 0 for a bound of 1', () => {
    const rng = createCryptoRng();
    expect(rng.int(1)).toBe(0);
  });

  it('covers the whole range over enough draws', () => {
    const rng = createCryptoRng();
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) seen.add(rng.int(6));
    expect(seen.size).toBe(6);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a bound of %p',
    (bound: number) => {
      expect(() => createCryptoRng().int(bound)).toThrow(RangeError);
    },
  );
});

describe('createRngFrom', () => {
  it('replays a scripted sequence, which is what makes tests deterministic', () => {
    const scripted = [3, 1, 4, 1, 5];
    let cursor = 0;
    const rng = createRngFrom(() => scripted[cursor++ % scripted.length] ?? 0);

    expect([rng.int(10), rng.int(10), rng.int(10)]).toEqual([3, 1, 4]);
  });

  it('rejects a source that leaves the requested range', () => {
    const rng = createRngFrom(() => 99);
    expect(() => rng.int(52)).toThrow(RangeError);
  });

  it('validates the bound before consulting the source', () => {
    let calls = 0;
    const rng = createRngFrom(() => {
      calls += 1;
      return 0;
    });

    expect(() => rng.int(0)).toThrow(RangeError);
    expect(calls).toBe(0);
  });
});

describe('seededRng', () => {
  it('replays the same sequence for the same seed', () => {
    const a = seededRng('deal-1');
    const b = seededRng('deal-1');
    const drawsA = Array.from({ length: 100 }, () => a.int(52));
    const drawsB = Array.from({ length: 100 }, () => b.int(52));

    expect(drawsA).toEqual(drawsB);
  });

  it('gives a different sequence for a different seed', () => {
    const draw = (seed: string): number[] => {
      const rng = seededRng(seed);
      return Array.from({ length: 50 }, () => rng.int(52));
    };

    expect(draw('deal-1')).not.toEqual(draw('deal-2'));
  });

  it('is stable across releases, so a recorded hand still replays', () => {
    const rng = seededRng('golden');
    expect([rng.int(52), rng.int(52), rng.int(6), rng.int(1000)]).toEqual([16, 21, 2, 886]);
  });

  it('stays inside the requested range', () => {
    const rng = seededRng('range');
    for (let i = 0; i < 5_000; i += 1) {
      const value = rng.int(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('covers the whole range', () => {
    const rng = seededRng('coverage');
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) seen.add(rng.int(6));
    expect(seen.size).toBe(6);
  });

  it('rejects a bound it cannot sample without bias', () => {
    expect(() => seededRng('big').int(0x1_0000_0001)).toThrow(RangeError);
  });
});
