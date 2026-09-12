import { describe, expect, it } from 'vitest';
import { DEFAULT_RADII, chipOffset, seatPositions } from '../lib/seats';

describe('seatPositions', () => {
  it('puts the viewer at bottom-centre, whichever seat they are in', () => {
    for (const viewer of [0, 3, 8]) {
      const positions = seatPositions(9, viewer);
      const mine = positions.find((position) => position.seatIndex === viewer);

      expect(mine?.slot).toBe(0);
      expect(mine?.xPercent).toBeCloseTo(50, 6);
      expect(mine?.yPercent).toBeCloseTo(50 + DEFAULT_RADII.ry, 6);
    }
  });

  it('falls back to seat 0 at the bottom for somebody only watching', () => {
    const positions = seatPositions(6, null);
    expect(positions[0]?.slot).toBe(0);
    expect(positions[0]?.yPercent).toBeCloseTo(50 + DEFAULT_RADII.ry, 6);
  });

  it('puts the next seat round to the viewer’s left', () => {
    const positions = seatPositions(6, 2);
    const next = positions.find((position) => position.seatIndex === 3);

    expect(next?.slot).toBe(1);
    expect(next?.xPercent).toBeLessThan(50);
    expect(next?.yPercent).toBeGreaterThan(50);
  });

  it('gives every seat its own place', () => {
    const positions = seatPositions(9, 4);
    const places = new Set(
      positions.map(
        (position) => `${position.xPercent.toFixed(4)},${position.yPercent.toFixed(4)}`,
      ),
    );

    expect(positions).toHaveLength(9);
    expect(places.size).toBe(9);
    expect(new Set(positions.map((position) => position.slot)).size).toBe(9);
  });

  it('keeps every seat on the ellipse', () => {
    for (const position of seatPositions(9, 0)) {
      const x = (position.xPercent - 50) / DEFAULT_RADII.rx;
      const y = (position.yPercent - 50) / DEFAULT_RADII.ry;
      expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
    }
  });
});

describe('chipOffset', () => {
  it('pushes a seat’s chips toward the middle of the table', () => {
    const bottom = seatPositions(2, 0)[0];
    if (!bottom) throw new Error('a two-seat table has a seat 0');

    const offset = chipOffset(bottom);
    // The viewer is at the bottom, so their chips move up the screen.
    expect(offset.dy).toBeLessThan(0);
    expect(Math.abs(offset.dx)).toBeLessThan(0.001);
  });
});
