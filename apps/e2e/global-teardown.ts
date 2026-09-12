import { stopServers } from './servers';

export default function globalTeardown(): void {
  stopServers();
}
