'use client';

import { AVATAR_SEEDS } from '../../lib/avatar';
import { Avatar } from '../ui/Avatar';
import { cx } from '../../lib/cx';

/**
 * Pick a face.
 *
 * Twelve fixed seeds rather than a random draw: the same seed always renders the
 * same avatar, so a player looks the same to everybody at the table and on every
 * device, and there is nothing to store but the string. (`Math.random` is banned
 * repo-wide anyway — CLAUDE.md §3.)
 *
 * It is a radio group, so arrow keys move through it and a reader announces the
 * selection.
 */
export function AvatarPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange(seed: string): void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-neutral-300">Avatar</legend>

      <div role="radiogroup" aria-label="Avatar" className="grid grid-cols-6 gap-2">
        {AVATAR_SEEDS.map((seed) => {
          const selected = seed === value;

          return (
            <button
              key={seed}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={seed.replace(/-/g, ' ')}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onChange(seed);
              }}
              className={cx(
                'grid h-11 w-full place-items-center rounded-xl transition-[background-color]',
                selected ? 'bg-accent/15 ring-accent ring-2' : 'hover:bg-white/5',
              )}
            >
              <Avatar seed={seed} name={name === '' ? '?' : name} size={32} />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
