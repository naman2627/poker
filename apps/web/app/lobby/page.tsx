'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  CLIENT_EVENTS,
  TABLE_CODE_LENGTH,
  TableCodeSchema,
  TableConfigSchema,
  type TableConfig,
} from '@poker/shared';
import { useSession } from '../../lib/auth/session';
import { currentSearch, isFixtureMode } from '../../lib/env';
import { createSocketTransport } from '../../lib/net/socket-transport';
import { FIXTURE_TABLE_CODE } from '../../fixtures/scripted-hand';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Shell } from '../../components/ui/Shell';

/**
 * Start a table, or join one.
 *
 * The form's numbers are checked here with the same `TableConfigSchema` the
 * server parses them with, so an impossible table is refused before it is sent
 * rather than bouncing back as an error. The server checks them again — it
 * always does (CLAUDE.md §4) — this is only about not wasting the round trip.
 *
 * "Starting stack" is one number in the interface and two on the wire: a table
 * where everyone buys in for the same amount is the only kind worth having in a
 * game between friends, so `minBuyIn` and `maxBuyIn` are set to it.
 */
const SEAT_OPTIONS = [2, 4, 6, 8, 9] as const;
const TIMER_OPTIONS = [15, 30, 45, 60] as const;

export default function LobbyPage() {
  const router = useRouter();
  const { session, hydrate, hydrated } = useSession();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (session === null) router.replace('/');
    else if (!session.user.profileComplete) router.replace('/auth/profile');
  }, [hydrated, router, session]);

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-5 py-10">
        <header className="flex items-center gap-3">
          <Avatar
            seed={session?.user.avatarSeed ?? null}
            name={session?.user.displayName ?? '?'}
            size={44}
          />
          <div>
            <h1 className="text-xl font-semibold text-neutral-50">
              {session?.user.displayName ?? 'Lobby'}
            </h1>
            <p className="text-xs text-neutral-500">Play money. No cash-out, ever.</p>
          </div>

          <Button
            variant="quiet"
            className="ml-auto px-0 text-xs"
            onClick={() => router.push('/leaderboard')}
          >
            Leaderboard
          </Button>
        </header>

        <JoinCard onOpen={(code) => router.push(`/table/${code}`)} />
        <CreateCard onOpen={(code) => router.push(`/table/${code}`)} />
      </div>
    </Shell>
  );
}

function JoinCard({ onOpen }: { onOpen(code: string): void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = TableCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'that is not a table code');
      return;
    }
    onOpen(parsed.data);
  };

  return (
    <Card title="Join a table" subtitle="Six characters, from whoever dealt you in.">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Field
            label="Table code"
            value={code}
            error={error}
            maxLength={TABLE_CODE_LENGTH}
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={FIXTURE_TABLE_CODE}
            className="tabular text-center text-lg tracking-[0.4em] uppercase"
            onChange={(event) => {
              setError(null);
              setCode(event.currentTarget.value.toUpperCase());
            }}
          />
        </div>
        <Button type="submit" variant="secondary" className="sm:mb-0.5 sm:w-32">
          Join
        </Button>
      </form>
    </Card>
  );
}

function CreateCard({ onOpen }: { onOpen(code: string): void }) {
  const { session } = useSession();

  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [startingStack, setStartingStack] = useState(1000);
  const [seatCount, setSeatCount] = useState(6);
  const [actionTimeoutSec, setActionTimeoutSec] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const parsed = TableConfigSchema.safeParse({
      seatCount,
      smallBlind,
      bigBlind,
      minBuyIn: startingStack,
      maxBuyIn: startingStack,
      actionTimeoutSec,
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'that table will not work');
      return;
    }

    if (isFixtureMode(currentSearch())) {
      // Nothing to create: the recording is the only table there is.
      onOpen(FIXTURE_TABLE_CODE);
      return;
    }

    if (session === null) return;
    setBusy(true);

    // A socket for one round trip. The table page opens its own; keeping this
    // one alive would mean two sockets for the same user, and the server drops
    // the first one when the second arrives.
    const transport = createSocketTransport(session.accessToken);
    try {
      const ack = await transport.emit<{ code: string; config: TableConfig }>(
        CLIENT_EVENTS.tableCreate,
        { config: parsed.data },
      );
      if (!ack.ok) {
        setError(ack.error.message);
        return;
      }
      onOpen(ack.data.code);
    } finally {
      transport.close();
      setBusy(false);
    }
  };

  return (
    <Card title="Deal a new table" subtitle="You pick the stakes; the server deals the cards.">
      <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Small blind"
            type="number"
            min={1}
            inputMode="numeric"
            value={smallBlind}
            className="tabular"
            onChange={(event) => {
              setSmallBlind(event.currentTarget.valueAsNumber || 0);
            }}
          />
          <Field
            label="Big blind"
            type="number"
            min={1}
            inputMode="numeric"
            value={bigBlind}
            className="tabular"
            onChange={(event) => {
              setBigBlind(event.currentTarget.valueAsNumber || 0);
            }}
          />
        </div>

        <Field
          label="Starting stack"
          type="number"
          min={1}
          inputMode="numeric"
          value={startingStack}
          className="tabular"
          hint={`Everyone buys in for the same amount. At least two big blinds (${String(bigBlind * 2)}).`}
          onChange={(event) => {
            setStartingStack(event.currentTarget.valueAsNumber || 0);
          }}
        />

        <Choice
          label="Seats"
          options={SEAT_OPTIONS}
          value={seatCount}
          format={(value) => String(value)}
          onChange={setSeatCount}
        />

        <Choice
          label="Action timer"
          options={TIMER_OPTIONS}
          value={actionTimeoutSec}
          format={(value) => `${String(value)}s`}
          onChange={setActionTimeoutSec}
        />

        {error === null ? null : (
          <p role="alert" className="text-danger text-xs font-medium">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? 'Dealing…' : 'Create the table'}
        </Button>
      </form>
    </Card>
  );
}

function Choice<T extends number>({
  label,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  format(value: T): string;
  onChange(value: T): void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-neutral-300">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            tabIndex={option === value ? 0 : -1}
            onClick={() => {
              onChange(option);
            }}
            className={
              option === value
                ? 'bg-accent text-felt-950 tabular min-h-11 flex-1 rounded-lg text-sm font-semibold'
                : 'tabular min-h-11 flex-1 rounded-lg text-sm text-neutral-300 ring-1 ring-white/15 hover:bg-white/10'
            }
          >
            {format(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-white/10 bg-black/25 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-neutral-50">{title}</h2>
        <p className="text-xs text-neutral-500">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}
