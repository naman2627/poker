'use client';

import { Settings } from '../../components/settings/Settings';

/**
 * `/settings` — how the table looks and sounds, for one person on one device.
 *
 * Nothing here reaches the server, so there is nothing to fetch and nothing to
 * wait for; the page is whatever the browser has already remembered.
 */
export default function SettingsPage() {
  return <Settings />;
}
