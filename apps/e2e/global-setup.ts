import { startServers } from './servers';

export default async function globalSetup(): Promise<void> {
  await startServers();
}
