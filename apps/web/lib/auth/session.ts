'use client';

import { create } from 'zustand';
import type { PublicUser } from '@poker/shared';

/**
 * The signed-in session, as the browser holds it.
 *
 * The access token lives in `sessionStorage`, not `localStorage` and not a
 * cookie this code can read: it is short-lived by design (the server issues 15
 * minutes), the long-lived refresh token is in an httpOnly cookie the browser
 * will not hand to script, and a token that dies with the tab is one fewer thing
 * left behind on a shared machine.
 *
 * The pending sign-in — which number was given a code — is kept here too, so
 * `/auth/verify` has something to verify against after a reload.
 */
export interface Session {
  readonly accessToken: string;
  readonly user: PublicUser;
}

export interface PendingSignIn {
  readonly requestId: string;
  readonly phone: string;
  /** Epoch milliseconds the code stops working, for the resend countdown. */
  readonly expiresAt: number;
}

interface SessionStore {
  readonly session: Session | null;
  readonly pending: PendingSignIn | null;
  readonly hydrated: boolean;
  hydrate(): void;
  startSignIn(pending: PendingSignIn): void;
  signIn(session: Session): void;
  updateUser(user: PublicUser): void;
  signOut(): void;
}

const SESSION_KEY = 'poker.session';
const PENDING_KEY = 'poker.pending-signin';

export const useSession = create<SessionStore>((set, get) => ({
  session: null,
  pending: null,
  hydrated: false,

  hydrate() {
    if (get().hydrated) return;
    set({
      session: read<Session>(SESSION_KEY),
      pending: read<PendingSignIn>(PENDING_KEY),
      hydrated: true,
    });
  },

  startSignIn(pending) {
    write(PENDING_KEY, pending);
    set({ pending });
  },

  signIn(session) {
    write(SESSION_KEY, session);
    write(PENDING_KEY, null);
    set({ session, pending: null });
  },

  updateUser(user) {
    const current = get().session;
    if (!current) return;
    const next: Session = { ...current, user };
    write(SESSION_KEY, next);
    set({ session: next });
  },

  signOut() {
    write(SESSION_KEY, null);
    write(PENDING_KEY, null);
    set({ session: null, pending: null });
  },
}));

function read<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    // Private browsing, a cleared store, a half-written value: none of them are
    // worth a crash on a sign-in screen. Start signed out instead.
    return null;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the session simply will not survive a reload.
  }
}
