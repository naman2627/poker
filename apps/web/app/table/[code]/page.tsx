'use client';

import { use } from 'react';
import { TableScreen } from '../../../components/table/TableScreen';

/**
 * `/table/[code]` — the table.
 *
 * The route only resolves the code. Everything else is a client concern, because
 * everything else comes down a socket: there is nothing to render on the server
 * that would still be true by the time it arrived.
 */
export default function TablePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  return <TableScreen code={code.toUpperCase()} />;
}
