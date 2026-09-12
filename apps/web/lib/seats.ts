/**
 * Where each seat sits on the felt.
 *
 * The viewer is always at bottom-centre and everybody else rotates around them,
 * so a player's own seat is in the same place at every table they ever join.
 * Seats run clockwise at a real table; on screen that puts the player to your
 * left at your bottom-left, which is where people expect to find them.
 *
 * Pure geometry: percentages of the felt box, no DOM, no React.
 */
export interface SeatPosition {
  readonly seatIndex: number;
  /** Percentage of the felt's width, 0 (left) to 100 (right). */
  readonly xPercent: number;
  /** Percentage of the felt's height, 0 (top) to 100 (bottom). */
  readonly yPercent: number;
  /** 0 for the viewer's own seat, then clockwise around the table. */
  readonly slot: number;
}

export interface EllipseRadii {
  /** Half-width of the seat ring, as a percentage of the felt box. */
  readonly rx: number;
  /** Half-height of the seat ring, as a percentage of the felt box. */
  readonly ry: number;
}

export const DEFAULT_RADII: EllipseRadii = { rx: 44, ry: 40 };

/**
 * @param seatCount how many seats the table has (2..9)
 * @param viewerSeatIndex the seat to pin to bottom-centre, or null when watching
 */
export function seatPositions(
  seatCount: number,
  viewerSeatIndex: number | null,
  radii: EllipseRadii = DEFAULT_RADII,
): readonly SeatPosition[] {
  const anchor = viewerSeatIndex ?? 0;
  const step = (Math.PI * 2) / seatCount;

  return Array.from({ length: seatCount }, (_unused, seatIndex) => {
    const slot = (seatIndex - anchor + seatCount) % seatCount;
    // Screen y grows downward, so a quarter turn puts slot 0 at the bottom.
    const theta = Math.PI / 2 + slot * step;

    return {
      seatIndex,
      slot,
      xPercent: 50 + radii.rx * Math.cos(theta),
      yPercent: 50 + radii.ry * Math.sin(theta),
    };
  });
}

/**
 * Which side of the felt a seat is on, so its chip stack can be pushed toward
 * the middle rather than sitting on top of the avatar.
 */
export function chipOffset(position: SeatPosition): { dx: number; dy: number } {
  const toCentreX = 50 - position.xPercent;
  const toCentreY = 50 - position.yPercent;
  const length = Math.hypot(toCentreX, toCentreY) || 1;
  return { dx: (toCentreX / length) * 13, dy: (toCentreY / length) * 11 };
}
