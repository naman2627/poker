import { z } from 'zod';

/**
 * Branded ids. A PlayerId and a TableId are both strings at runtime, but the
 * compiler will not let you pass one where the other is expected.
 */
export const PlayerIdSchema = z.uuid().brand<'PlayerId'>();
export type PlayerId = z.infer<typeof PlayerIdSchema>;

export const TableIdSchema = z.uuid().brand<'TableId'>();
export type TableId = z.infer<typeof TableIdSchema>;

export const HandIdSchema = z.uuid().brand<'HandId'>();
export type HandId = z.infer<typeof HandIdSchema>;

/** Zero-based seat position at a table. */
export const SeatIndexSchema = z.number().int().min(0).max(9).brand<'SeatIndex'>();
export type SeatIndex = z.infer<typeof SeatIndexSchema>;

/**
 * Play-money chips, always whole units. There is no currency here and there
 * never will be — see CLAUDE.md.
 */
export const ChipsSchema = z.number().int().nonnegative().brand<'Chips'>();
export type Chips = z.infer<typeof ChipsSchema>;
