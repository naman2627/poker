'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CLIENT_EVENTS } from '@poker/shared';
import { useSession } from '../../lib/auth/session';
import { useTableConnection } from '../../lib/net/use-table-connection';
import { useFixtureControls } from '../../lib/use-fixture';
import { potTotal } from '../../lib/store/patch';
import { isLive, useTableStore } from '../../lib/store/table-store';
import { ActionBar } from './ActionBar';
import { ConnectionBadge } from './ConnectionBadge';
import { FixtureBar } from './FixtureBar';
import { HandLog } from './HandLog';
import { HandResultPanel } from './HandResultPanel';
import { LiveLeaderboard } from './LiveLeaderboard';
import { SeatPicker } from './SeatPicker';
import { TableControls } from './TableControls';
import { TableFelt } from './TableFelt';
import { Button } from '../ui/Button';
import { Shell } from '../ui/Shell';
import { chips } from '../../lib/format';

/**
 * Everything at a table.
 *
 * The whole screen is a function of the store, and the store is a function of
 * what the server sent. There is no local model of the game running alongside it
 * — if a number is on this screen, a `state:sync` or a `state:patch` put it
 * there.
 *
 * The one thing the client decides for itself is whether it can be heard: while
 * the link is down every control that would send something is disabled, so a
 * player never fires an action into a socket that is not there.
 */
export function TableScreen({ code }: { code: string }) {
  const router = useRouter();
  const { session, hydrate, hydrated } = useSession();

  const store = useTableStore();
  useTableConnection(code, session?.accessToken ?? null);
  const controls = useFixtureControls();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Fixture mode has no account behind it, so it does not need one to sit down.
  useEffect(() => {
    if (hydrated && session === null && store.transportKind === 'socket') router.replace('/');
  }, [hydrated, router, session, store.transportKind]);

  const state = store.state;
  const config = store.config;
  const live = isLive(store.status);
  const viewerSeat = state?.viewerSeatIndex ?? null;
  const seat = state !== null && viewerSeat !== null ? (state.seats[viewerSeat] ?? null) : null;
  const myTurn = store.prompt !== null && store.prompt.seatIndex === viewerSeat;

  const send = (event: string, payload?: unknown): void => {
    void store.send(event, payload);
  };

  return (
    <Shell className="pb-32 sm:pb-0">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" className="px-0" onClick={() => router.push('/lobby')}>
            &larr; Lobby
          </Button>

          <h1 className="tabular text-lg font-semibold tracking-[0.25em] text-neutral-50">
            {state?.tableCode === '' || state?.tableCode === undefined ? code : state.tableCode}
          </h1>

          {state ? (
            <p className="tabular text-xs text-neutral-500">
              {chips(state.smallBlind)}/{chips(state.bigBlind)} &middot; hand{' '}
              <span data-testid="hand-number">{state.handNumber}</span> &middot;{' '}
              <span data-testid="phase">{state.phase.replace('_', ' ')}</span>
              {state.paused ? ' · paused' : ''}
            </p>
          ) : null}

          <Button
            variant="quiet"
            className="px-0 text-xs"
            onClick={() => router.push(`/table/${code}/history`)}
          >
            Hand history
          </Button>

          <Button
            variant="quiet"
            className="px-0 text-xs"
            onClick={() => router.push('/leaderboard')}
          >
            Leaderboard
          </Button>

          <span className="ml-auto">
            <ConnectionBadge
              status={store.status}
              attempt={store.reconnectAttempt}
              notice={store.notice}
            />
          </span>
        </header>

        {controls ? <FixtureBar controls={controls} /> : null}
        {store.status === 'reconnecting' ? <ReconnectingBanner /> : null}
        {store.status === 'closed' || store.status === 'error' ? (
          <DisconnectedBanner
            message={store.error?.message ?? store.notice ?? 'The link to the table is gone.'}
          />
        ) : null}

        {store.error && store.status !== 'error' ? (
          <div
            role="alert"
            className="border-danger/40 text-danger flex items-center gap-3 rounded-xl border bg-black/40 px-4 py-2.5 text-sm"
          >
            <span className="flex-1">{store.error.message}</span>
            <Button variant="quiet" className="min-h-9 px-2 text-xs" onClick={store.dismissError}>
              Dismiss
            </Button>
          </div>
        ) : null}

        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            {state === null ? (
              <Waiting status={store.status} />
            ) : (
              <TableFelt
                state={state}
                prompt={store.prompt}
                result={store.result}
                viewerCards={store.holeCards}
                awarded={store.awarded}
                timeoutSec={config?.actionTimeoutSec ?? 30}
              />
            )}

            {state && myTurn && store.prompt ? (
              <ActionBar
                prompt={store.prompt}
                bigBlind={state.bigBlind}
                potTotal={potTotal(state, store.awarded)}
                currentBet={state.currentBet}
                pending={store.pending || !live}
                act={(action) => void store.act(action)}
              />
            ) : null}

            {state && seat === null ? (
              <SeatPicker
                state={state}
                config={config}
                disabled={!live}
                onSit={(seatIndex, buyIn) => {
                  send(CLIENT_EVENTS.tableSit, { seatIndex, buyIn });
                }}
              />
            ) : null}

            {state && seat ? (
              <TableControls
                state={state}
                seat={seat}
                config={config}
                isHost={state.hostUserId !== null && state.hostUserId === session?.user.id}
                live={live}
                canShow={state.handId !== null && state.muckedSeats.includes(seat.seatIndex)}
                onSitOut={(sittingOut) => {
                  send(CLIENT_EVENTS.playerSitOut, { sittingOut });
                }}
                onLeave={() => {
                  send(CLIENT_EVENTS.tableLeave);
                }}
                onRebuy={(amount) => {
                  send(CLIENT_EVENTS.playerRebuy, { amount });
                }}
                onPause={(paused) => {
                  send(CLIENT_EVENTS.tablePause, { paused });
                }}
                onShow={() => {
                  send(CLIENT_EVENTS.playerShow, { handId: state.handId });
                }}
              />
            ) : null}
          </div>

          <aside className="flex min-h-0 flex-col gap-4">
            <HandResultPanel result={store.result} state={state} />
            {state ? (
              <LiveLeaderboard
                rows={state.leaderboard}
                viewerUserId={session?.user.id ?? null}
                bigBlind={state.bigBlind}
              />
            ) : null}
            <HandLog log={store.log} chat={store.chat} />
          </aside>
        </div>
      </div>
    </Shell>
  );
}

function ReconnectingBanner() {
  return (
    <p
      role="status"
      className="rounded-xl border border-amber-300/30 bg-amber-300/5 px-4 py-2.5 text-sm text-amber-200"
    >
      Reconnecting to the table. Your seat and your chips are being held, and the clock on your turn
      is still running.
    </p>
  );
}

function DisconnectedBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="border-danger/40 text-danger flex flex-wrap items-center gap-3 rounded-xl border bg-black/40 px-4 py-2.5 text-sm"
    >
      <span className="flex-1">{message}</span>
      <Button
        variant="secondary"
        className="min-h-9 px-3 text-xs"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reconnect
      </Button>
    </div>
  );
}

function Waiting({ status }: { status: string }) {
  return (
    <div className="grid min-h-64 flex-1 place-items-center rounded-2xl border border-white/10 bg-black/20">
      <p className="text-sm text-neutral-500">
        {status === 'error' || status === 'closed'
          ? 'Could not reach the table.'
          : 'Waiting for the table…'}
      </p>
    </div>
  );
}
