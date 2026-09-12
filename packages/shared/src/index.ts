/**
 * @poker/shared — the vocabulary both sides of the wire agree on.
 *
 * Types and zod schemas only. No poker rules (those live in @poker/engine),
 * no I/O, no framework imports. Runtime dependency: zod.
 */
export * from './ids';
export * from './auth';
export * from './table';
export * from './history';
export * from './stats';
export * from './errors';
export * from './health';
