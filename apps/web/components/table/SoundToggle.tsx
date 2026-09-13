'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePrefs } from '../../lib/prefs/store';
import { playSound } from '../../lib/sound/engine';
import { cx } from '../../lib/cx';

/**
 * The two switches, in the table header.
 *
 * In the header rather than in `TableControls` because that panel only exists
 * for somebody who is sitting down — and a person watching a table wants the
 * sound off just as much as a person playing it does.
 *
 * The chime reads as its own line, not as a child of the one above it, because
 * that is what it is: turning the table sounds off does not turn the chime off.
 * See `shouldPlay` in `lib/sound/sounds.ts`.
 *
 * Switching either one on plays it once, immediately. That is not a flourish —
 * it is the only way to find out what you have just agreed to, and it doubles
 * as proof the browser actually let the audio start.
 *
 * Everything else — the deck, the volume slider, the phrases — is one link
 * away rather than crammed in here. This popover exists for the thing you want
 * to change *during* a hand.
 */
export function SoundToggle() {
  const router = useRouter();
  const { soundEnabled, turnChime, volume, hydrated, hydrate, setSoundEnabled, setTurnChime } =
    usePrefs();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Until the preference has been read, say nothing rather than flash "off" at
  // somebody who has it on.
  const anyOn = hydrated && (soundEnabled || turnChime);

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-label={anyOn ? 'Sound settings — some sounds on' : 'Sound settings — all sounds off'}
        title="Sound"
        className={cx(
          'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors',
          anyOn ? 'text-accent hover:bg-white/10' : 'text-neutral-500 hover:text-neutral-200',
        )}
      >
        <span aria-hidden className="text-sm">
          {anyOn ? '🔊' : '🔇'}
        </span>
        Sound
      </button>

      {open ? (
        <div
          role="group"
          aria-label="Sound settings"
          className="absolute top-full right-0 z-20 mt-1 w-64 rounded-xl border border-white/15 bg-neutral-900/95 p-2 shadow-xl backdrop-blur"
        >
          <Switch
            label="Table sounds"
            hint="Dealing, chips, checks and folds."
            checked={soundEnabled}
            onChange={(next) => {
              setSoundEnabled(next);
              if (next) playSound('chip', volume);
            }}
          />
          <Switch
            label="Your-turn chime"
            hint="Plays even with table sounds off."
            checked={turnChime}
            onChange={(next) => {
              setTurnChime(next);
              if (next) playSound('turn', volume);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/settings');
            }}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
          >
            Volume, deck and quick phrases &rarr;
          </button>
        </div>
      ) : null}
    </span>
  );
}

function Switch({
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
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-white/5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
        className="accent-accent mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-neutral-100">{label}</span>
        <span className="block text-[11px] leading-snug text-neutral-500">{hint}</span>
      </span>
    </label>
  );
}
