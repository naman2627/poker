'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '../../lib/auth/session';
import { usePrefs } from '../../lib/prefs/store';
import { MAX_PHRASES, MAX_PHRASE_LENGTH, normalisePhrases } from '../../lib/prefs/prefs';
import { playSound } from '../../lib/sound/engine';
import { PlayingCard } from '../table/PlayingCard';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Shell } from '../ui/Shell';
import { cx } from '../../lib/cx';

/**
 * How the table looks and sounds, for one person.
 *
 * Everything here is stored on the device and never sent anywhere. That is not
 * an omission — none of it is a fact about the game, so none of it belongs on
 * the server. A four-colour deck changes what *you* see; it cannot change what
 * a hand is worth.
 *
 * Each control takes effect the moment it is touched. There is no Save button
 * because there is nothing to save: a settings page that makes you confirm a
 * volume slider is a settings page that has forgotten what it is for.
 */
export function Settings() {
  const router = useRouter();
  const { session, hydrate: hydrateSession, hydrated } = useSession();
  const prefs = usePrefs();

  useEffect(() => {
    hydrateSession();
    prefs.hydrate();
  }, [hydrateSession, prefs]);

  useEffect(() => {
    if (hydrated && session === null) router.replace('/');
  }, [hydrated, router, session]);

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" className="px-0" onClick={() => router.push('/lobby')}>
            &larr; Lobby
          </Button>
          <h1 className="text-lg font-semibold text-neutral-50">Settings</h1>
        </header>

        <section className="flex items-center gap-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-4">
          <Avatar
            seed={session?.user.avatarSeed ?? null}
            name={session?.user.displayName ?? '?'}
            size={48}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-50">
              {session?.user.displayName ?? 'Signed in'}
            </p>
            <p className="text-xs text-neutral-500">
              These settings live on this device, not on your account.
            </p>
          </div>
        </section>

        <Group title="Cards" hint="How the deck is printed for you.">
          <Choice
            label="Deck"
            options={[
              { value: 'classic', label: 'Classic', hint: 'Two colours, like paper.' },
              {
                value: 'four-colour',
                label: 'Four colour',
                hint: 'A colour per suit — harder to misread a flush.',
              },
            ]}
            value={prefs.deck}
            onChange={(value) => {
              prefs.setDeck(value === 'four-colour' ? 'four-colour' : 'classic');
            }}
          />

          <div
            className="flex gap-1.5 rounded-xl border border-white/10 bg-black/20 px-3 py-3"
            aria-label="Deck preview"
          >
            <PlayingCard card={{ rank: 14, suit: 's' }} size="sm" />
            <PlayingCard card={{ rank: 13, suit: 'h' }} size="sm" />
            <PlayingCard card={{ rank: 12, suit: 'd' }} size="sm" />
            <PlayingCard card={{ rank: 11, suit: 'c' }} size="sm" />
            <p className="self-center pl-2 text-xs text-neutral-500">
              Diamonds and clubs change; spades and hearts never do.
            </p>
          </div>
        </Group>

        <Group title="Sound" hint="Both off by default. The chime is its own switch.">
          <Toggle
            label="Table sounds"
            hint="Dealing, chips, checks and folds."
            checked={prefs.soundEnabled}
            onChange={(next) => {
              prefs.setSoundEnabled(next);
              if (next) playSound('chip', prefs.volume);
            }}
          />
          <Toggle
            label="Your-turn chime"
            hint="Plays even with table sounds off — it is the one worth keeping on."
            checked={prefs.turnChime}
            onChange={(next) => {
              prefs.setTurnChime(next);
              if (next) playSound('turn', prefs.volume);
            }}
          />

          <div className="flex items-center gap-3 px-1 py-2">
            <label htmlFor="volume" className="w-20 shrink-0 text-xs text-neutral-400">
              Volume
            </label>
            <input
              id="volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(prefs.volume * 100)}
              aria-valuetext={`${String(Math.round(prefs.volume * 100))} per cent`}
              onChange={(event) => {
                prefs.setVolume(event.currentTarget.valueAsNumber / 100);
              }}
              className="accent-accent h-11 min-w-0 flex-1 cursor-pointer"
            />
            <span className="tabular w-10 text-right text-xs text-neutral-500">
              {Math.round(prefs.volume * 100)}
            </span>
            <Button
              variant="ghost"
              className="min-h-9 px-3 text-xs"
              onClick={() => {
                playSound('turn', prefs.volume);
              }}
            >
              Test
            </Button>
          </div>
        </Group>

        <QuickPhrases
          phrases={prefs.quickPhrases}
          onChange={(text) => {
            prefs.setQuickPhrases(text);
          }}
        />

        <Group title="Keyboard" hint="On your turn, when you are not typing.">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-1 text-sm">
            {(
              [
                ['F', 'Fold'],
                ['C', 'Check, or call'],
                ['R', 'Open the raise panel'],
                ['H', 'Load half the pot'],
                ['P', 'Load the pot'],
                ['A', 'Load your whole stack'],
                ['Enter', 'Confirm the amount'],
              ] as const
            ).map(([key, what]) => (
              <div key={key} className="contents">
                <dt>
                  <kbd className="tabular rounded border border-white/15 bg-white/10 px-1.5 py-0.5 text-[0.7rem] text-neutral-300">
                    {key}
                  </kbd>
                </dt>
                <dd className="text-neutral-400">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="px-1 text-xs text-neutral-500">
            H, P and A only fill in the amount. Nothing is sent until you press Enter.
          </p>
        </Group>
      </div>
    </Shell>
  );
}

function QuickPhrases({
  phrases,
  onChange,
}: {
  phrases: readonly string[];
  onChange(text: string): void;
}) {
  const [draft, setDraft] = useState(() => phrases.join('\n'));
  const [touched, setTouched] = useState(false);

  // Until the player edits, follow the stored value — it arrives a tick after
  // mount, once the preferences have been read off the device.
  const shown = touched ? draft : phrases.join('\n');
  const preview = normalisePhrases(shown);

  return (
    <Group
      title="Quick phrases"
      hint={`One per line, up to ${String(MAX_PHRASES)}. They appear as buttons under the chat box.`}
    >
      <textarea
        aria-label="Quick phrases, one per line"
        rows={6}
        value={shown}
        onChange={(event) => {
          setTouched(true);
          setDraft(event.currentTarget.value);
          onChange(event.currentTarget.value);
        }}
        className={cx(
          'w-full rounded-xl bg-black/30 px-3 py-2.5 text-sm text-neutral-100',
          'ring-1 ring-white/10 placeholder:text-neutral-600',
        )}
        placeholder={'Nice hand\nGood fold\nOne sec'}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {preview.length === 0 ? (
          <p className="text-xs text-neutral-500">No phrases — the chat box stands alone.</p>
        ) : (
          preview.map((phrase) => (
            <span
              key={phrase}
              className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-neutral-300 ring-1 ring-white/10"
            >
              {phrase}
            </span>
          ))
        )}
      </div>
      <p className="text-xs text-neutral-500">
        Blank lines and duplicates are dropped, and each one is cut to {String(MAX_PHRASE_LENGTH)}{' '}
        characters. What you see above is what you get.
      </p>
    </Group>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-semibold tracking-[0.18em] text-neutral-400 uppercase">
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/25 p-3">
        {children}
      </div>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
        className="accent-accent mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-sm text-neutral-100">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  );
}

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: string; label: string; hint: string }[];
  value: string;
  onChange(next: string): void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-white/5"
        >
          <input
            type="radio"
            name={label}
            checked={value === option.value}
            onChange={() => {
              onChange(option.value);
            }}
            className="accent-accent mt-0.5 size-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm text-neutral-100">{option.label}</span>
            <span className="block text-xs text-neutral-500">{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
