'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { DisplayNameSchema } from '@poker/shared';
import { AuthRequestError, saveProfile } from '../../../lib/auth/api';
import { useSession } from '../../../lib/auth/session';
import { AVATAR_SEEDS } from '../../../lib/avatar';
import { AvatarPicker } from '../../../components/auth/AvatarPicker';
import { Avatar } from '../../../components/ui/Avatar';
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { Shell } from '../../../components/ui/Shell';

/**
 * Choose how you appear at a table.
 *
 * A display name is required — the server will not let an account without one
 * join a table, because a seat with no name on it is unplayable. Email is
 * genuinely optional and exists only for recovering an account later.
 */
const DEFAULT_SEED = AVATAR_SEEDS[0];

export default function ProfilePage() {
  const router = useRouter();
  const { session, hydrate, hydrated, updateUser } = useSession();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [avatarSeed, setAvatarSeed] = useState<string>(DEFAULT_SEED);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (hydrated && session === null) router.replace('/');
  }, [hydrated, router, session]);

  // Editing an existing profile starts from what is already there.
  const user = session?.user;
  const [seeded, setSeeded] = useState(false);
  if (user && !seeded) {
    setSeeded(true);
    setDisplayName(user.displayName);
    setEmail(user.email ?? '');
    setAvatarSeed(user.avatarSeed ?? DEFAULT_SEED);
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const parsed = DisplayNameSchema.safeParse(displayName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'that name will not do');
      return;
    }
    if (!session) return;

    setBusy(true);
    try {
      const { user: saved } = await saveProfile(session.accessToken, {
        displayName: parsed.data,
        avatarSeed,
        ...(email.trim() === '' ? {} : { email: email.trim() }),
      });
      updateUser(saved);
      router.replace('/lobby');
    } catch (caught: unknown) {
      setError(caught instanceof AuthRequestError ? caught.body.message : 'that did not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-7 px-5 py-12">
        <header className="flex items-center gap-4">
          <Avatar seed={avatarSeed} name={displayName === '' ? '?' : displayName} size={56} />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-neutral-50">How should we call you?</h1>
            <p className="text-sm text-neutral-400">This is the name on your seat.</p>
          </div>
        </header>

        <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
          <Field
            label="Display name"
            autoFocus
            autoComplete="nickname"
            maxLength={24}
            placeholder="Naman"
            value={displayName}
            error={error}
            hint="Two to 24 characters."
            onChange={(event) => {
              setDisplayName(event.currentTarget.value);
            }}
          />

          <Field
            label="Email (optional)"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            hint="Only for getting back into your account. Never shown at a table."
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />

          <AvatarPicker name={displayName} value={avatarSeed} onChange={setAvatarSeed} />

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? 'Saving…' : 'Continue to the lobby'}
          </Button>
        </form>
      </div>
    </Shell>
  );
}
