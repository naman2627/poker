'use client';

import { use } from 'react';
import { HandHistory } from '../../../../components/history/HandHistory';

/**
 * `/table/[code]/history` — the last fifty hands, each one replayable.
 *
 * Like the table itself, the route only resolves the code: everything else comes
 * from the server, and there is nothing to render before it answers.
 */
export default function HandHistoryPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  return <HandHistory code={code.toUpperCase()} />;
}
