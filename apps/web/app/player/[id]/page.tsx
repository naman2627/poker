'use client';

import { use } from 'react';
import { PlayerCard } from '../../../components/leaderboard/PlayerCard';

/**
 * `/player/[id]` — one player's stat card and their last twenty hands.
 *
 * The route resolves the id and nothing else; everything on the page comes from
 * the server, which decides what a reader is entitled to see.
 */
export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PlayerCard userId={id} />;
}
