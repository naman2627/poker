'use client';

import { Leaderboard } from '../../components/leaderboard/Leaderboard';

/**
 * `/leaderboard` — all time, this month, this week, on any of six metrics.
 *
 * Like every other page here, the route resolves nothing: the board comes from
 * the server, and there is nothing to render before it answers.
 */
export default function LeaderboardPage() {
  return <Leaderboard />;
}
