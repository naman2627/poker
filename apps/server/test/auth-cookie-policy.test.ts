/**
 * How the refresh cookie is scoped.
 *
 * This is one line of configuration with a failure mode that does not look like
 * a failure: get SameSite wrong and signing in still works, the table still
 * loads, and then the first page reload signs everybody out — because the
 * browser quietly declined to send the cookie back to /auth/refresh. Worth a
 * test of its own.
 */
import { describe, expect, it } from 'vitest';
import { cookiePolicyFor } from '../src/auth/policy';

describe('cookiePolicyFor', () => {
  it('lets the browser send the cookie across sites in production', () => {
    // The web client is on one domain and this server is on another — Vercel
    // and Render, say. Only SameSite=None survives that trip.
    expect(cookiePolicyFor('production')).toEqual({ secure: true, sameSite: 'none' });
  });

  it('stays on Lax for local development, where Secure is impossible', () => {
    // Plain http on localhost: a Secure cookie would be dropped outright, and
    // same-origin means Lax costs nothing.
    expect(cookiePolicyFor('development')).toEqual({ secure: false, sameSite: 'lax' });
  });

  it('never pairs SameSite=None with an insecure cookie', () => {
    // Browsers reject that combination, so it would silently lose the session.
    for (const env of ['development', 'test', 'production'] as const) {
      const policy = cookiePolicyFor(env);
      if (policy.sameSite === 'none') expect(policy.secure).toBe(true);
    }
  });
});
