import { cryptoRng, type Rng } from '@poker/engine';
import type { TableConfig } from '@poker/shared';
import type { HistoryRecorder } from '../history/recorder';
import type { StatsRecorder } from '../stats/recorder';
import { generateUniqueTableCode } from './codes';
import { TableError } from './errors';
import { TableRuntime, type Scheduler, type TableTimings } from './runtime';

export interface TableRegistryOptions {
  /** Randomness for table codes and for every deck this registry deals. */
  readonly rng?: Rng;
  readonly scheduler?: Scheduler;
  readonly timings?: TableTimings;
  /** Where every hand is written down. Absent means no record is kept. */
  readonly history?: HistoryRecorder | null;
  /** Where every hand is counted. Absent means no global board is kept. */
  readonly stats?: StatsRecorder | null;
  /** Injected only by tests, to pin the deck a hand is dealt from. */
  readonly deckSeeds?: () => string;
  readonly maxTables?: number;
}

/**
 * Every live table, by code.
 *
 * Nothing here is persisted: a restart drops the tables, which is the deal until
 * persistence lands. The registry owns the runtimes' lifetimes, so shutting the
 * server down stops every action timer with it.
 */
export class TableRegistry {
  readonly #tables = new Map<string, TableRuntime>();
  readonly #rng: Rng;
  readonly #scheduler: Scheduler | undefined;
  readonly #timings: TableTimings | undefined;
  readonly #history: HistoryRecorder | null;
  readonly #stats: StatsRecorder | null;
  readonly #deckSeeds: (() => string) | undefined;
  readonly #maxTables: number;

  constructor(options: TableRegistryOptions = {}) {
    this.#rng = options.rng ?? cryptoRng();
    this.#scheduler = options.scheduler;
    this.#timings = options.timings;
    this.#history = options.history ?? null;
    this.#stats = options.stats ?? null;
    this.#deckSeeds = options.deckSeeds;
    this.#maxTables = options.maxTables ?? 500;
  }

  get size(): number {
    return this.#tables.size;
  }

  /** `hostUserId` is whoever asked for the table; they are the only one who can pause it. */
  create(config: TableConfig, hostUserId: string | null = null): TableRuntime {
    if (this.#tables.size >= this.#maxTables) {
      throw TableError.conflict('this server is full — try again in a moment');
    }

    const code = generateUniqueTableCode(this.#rng, (candidate) => this.#tables.has(candidate));
    const table = new TableRuntime({
      code,
      config,
      rng: this.#rng,
      hostUserId,
      history: this.#history,
      stats: this.#stats,
      ...(this.#deckSeeds ? { deckSeeds: this.#deckSeeds } : {}),
      ...(this.#scheduler ? { scheduler: this.#scheduler } : {}),
      ...(this.#timings ? { timings: this.#timings } : {}),
    });

    this.#tables.set(code, table);
    this.#history?.record({
      kind: 'table-opened',
      code,
      hostUserId,
      config,
      at: new Date(),
    });
    return table;
  }

  get(code: string): TableRuntime | undefined {
    return this.#tables.get(code.toUpperCase());
  }

  /** The table behind a code, or a typed refusal a client can act on. */
  require(code: string): TableRuntime {
    const table = this.get(code);
    if (!table) throw TableError.notFound(`no table with the code ${code}`);
    return table;
  }

  remove(code: string): void {
    const table = this.#tables.get(code.toUpperCase());
    if (!table) return;
    table.close();
    this.#tables.delete(code.toUpperCase());
    this.#history?.record({ kind: 'table-closed', code: table.code, at: new Date() });
  }

  closeAll(): void {
    for (const table of this.#tables.values()) table.close();
    this.#tables.clear();
  }
}
