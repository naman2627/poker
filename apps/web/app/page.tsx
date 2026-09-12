'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { PhoneInputSchema } from '@poker/shared';
import { AuthRequestError, requestOtp } from '../lib/auth/api';
import { useSession } from '../lib/auth/session';
import { useFixtureMode } from '../lib/use-fixture';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Shell } from '../components/ui/Shell';

/**
 * Sign in.
 *
 * A phone number is the whole identity here — no password to choose, forget or
 * reuse. The number is only shape-checked in the browser; the server normalises
 * it properly and is the one that decides whether it is real.
 */
export default function LandingPage() {
  const router = useRouter();
  const { session, hydrate, startSignIn } = useSession();

  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (session) router.replace(session.user.profileComplete ? '/lobby' : '/auth/profile');
  }, [router, session]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const parsed = PhoneInputSchema.safeParse(phone);
    if (!parsed.success) {
      setError('that does not look like a phone number');
      return;
    }

    setBusy(true);
    try {
      const { requestId, expiresInSec } = await requestOtp(parsed.data);
      startSignIn({
        requestId,
        phone: parsed.data,
        expiresAt: Date.now() + expiresInSec * 1000,
      });
      router.push('/auth/verify');
    } catch (caught: unknown) {
      setError(caught instanceof AuthRequestError ? caught.body.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-5 py-12">
        <header className="space-y-3">
          <p className="text-accent text-xs font-semibold tracking-[0.2em] uppercase">
            Play money only
          </p>
          <h1 className="text-4xl font-semibold text-balance text-neutral-50">
            Texas Hold&rsquo;em
          </h1>
          <p className="text-sm text-neutral-400">
            Deal a private table for your friends. Chips are a counter and nothing else &mdash;
            there is no cash-out and never will be.
          </p>
        </header>

        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <Field
            label="Phone number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="+1 415 555 2671"
            value={phone}
            error={error}
            hint="We text you a six-digit code. That is the whole sign-up."
            onChange={(event) => {
              setPhone(event.currentTarget.value);
            }}
          />

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? 'Sending…' : 'Send me a code'}
          </Button>
        </form>

        <FixtureNote />
      </div>
    </Shell>
  );
}

/** Only rendered when there is no server behind the app. */
function FixtureNote() {
  const fixture = useFixtureMode();
  if (!fixture) return null;

  return (
    <p className="rounded-xl border border-dashed border-amber-300/30 bg-amber-300/5 px-4 py-3 text-xs text-amber-200/90">
      Running on fixtures — no server, no SMS. Any number works, and the code is{' '}
      <span className="tabular font-semibold">424242</span>.
    </p>
  );
}
