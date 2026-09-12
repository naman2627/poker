'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthRequestError, requestOtp, verifyOtp } from '../../../lib/auth/api';
import { useSession } from '../../../lib/auth/session';
import { emptyOtp, isOtpComplete, otpCode } from '../../../lib/otp';
import { OtpBoxes } from '../../../components/auth/OtpBoxes';
import { Button } from '../../../components/ui/Button';
import { Shell } from '../../../components/ui/Shell';

/**
 * Enter the code.
 *
 * The sixth digit submits on its own — there is a button, but nobody should need
 * it. Resending is on a visible countdown rather than a silent cooldown, because
 * "why is this button dead" is a worse experience than "23s".
 */
const RESEND_COOLDOWN_SEC = 30;

export default function VerifyPage() {
  const router = useRouter();
  const { pending, hydrate, hydrated, signIn, startSignIn } = useSession();

  const [digits, setDigits] = useState<string[]>(emptyOtp);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_COOLDOWN_SEC * 1000);
  const cooldown = useCooldown(resendAt);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Landing here without having asked for a code is a dead end; go back and ask.
  useEffect(() => {
    if (hydrated && pending === null) router.replace('/');
  }, [hydrated, pending, router]);

  const submit = useCallback(
    async (code: string): Promise<void> => {
      if (!pending || busy) return;
      setBusy(true);
      setError(null);

      try {
        const session = await verifyOtp(pending.requestId, code);
        signIn({ accessToken: session.accessToken, user: session.user });
        router.replace(session.user.profileComplete ? '/lobby' : '/auth/profile');
      } catch (caught: unknown) {
        setError(caught instanceof AuthRequestError ? caught.body.message : 'that did not work');
        setDigits(emptyOtp());
      } finally {
        setBusy(false);
      }
    },
    [busy, pending, router, signIn],
  );

  const resend = async (): Promise<void> => {
    if (!pending || cooldown > 0) return;
    setError(null);

    try {
      const { requestId, expiresInSec } = await requestOtp(pending.phone);
      startSignIn({
        requestId,
        phone: pending.phone,
        expiresAt: Date.now() + expiresInSec * 1000,
      });
      setDigits(emptyOtp());
      setResendAt(Date.now() + RESEND_COOLDOWN_SEC * 1000);
    } catch (caught: unknown) {
      setError(caught instanceof AuthRequestError ? caught.body.message : 'could not resend');
    }
  };

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-7 px-5 py-12">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-50">Enter your code</h1>
          <p className="text-sm text-neutral-400">
            Sent to <span className="tabular text-neutral-200">{pending?.phone ?? '…'}</span>.{' '}
            <button
              type="button"
              onClick={() => {
                router.replace('/');
              }}
              className="text-accent underline underline-offset-2"
            >
              Wrong number?
            </button>
          </p>
        </header>

        <div className="space-y-4">
          <OtpBoxes
            digits={digits}
            disabled={busy}
            invalid={error !== null}
            onChange={setDigits}
            onComplete={(code) => void submit(code)}
          />

          <p aria-live="polite" className="min-h-5 text-xs">
            {error === null ? (
              <span className="text-neutral-500">Paste the whole code — it will spread out.</span>
            ) : (
              <span className="text-danger font-medium">{error}</span>
            )}
          </p>

          <Button
            variant="primary"
            className="w-full"
            disabled={busy || !isOtpComplete(digits)}
            onClick={() => void submit(otpCode(digits))}
          >
            {busy ? 'Checking…' : 'Verify'}
          </Button>

          <Button
            variant="quiet"
            className="w-full"
            disabled={cooldown > 0}
            onClick={() => void resend()}
          >
            {cooldown > 0 ? (
              <>
                Resend in <span className="tabular ml-1">{cooldown}s</span>
              </>
            ) : (
              'Send a new code'
            )}
          </Button>
        </div>
      </div>
    </Shell>
  );
}

/**
 * Whole seconds until `readyAt`.
 *
 * The clock is the state; the number on the button is derived from it, so
 * pressing resend and getting a fresh `readyAt` shows the new countdown on the
 * next render rather than the next tick.
 */
function useCooldown(readyAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return Math.max(0, Math.ceil((readyAt - now) / 1000));
}
