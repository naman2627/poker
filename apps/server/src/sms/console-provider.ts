import type { OtpMessage, SmsProvider } from './provider';

/**
 * Local development only: prints the code to the server console so there is
 * something to type in without an SMS bill.
 *
 * This is the one place in the codebase allowed to put a plaintext code
 * anywhere, and it is reachable only when SMS_PROVIDER=console.
 */
export function createConsoleSmsProvider(): SmsProvider {
  return {
    name: 'console',
    sendOtp({ phone, code, expiresInSec }: OtpMessage): Promise<void> {
      const minutes = Math.round(expiresInSec / 60);
      console.info(
        `\n  ┌─ SMS (console provider — development only)\n` +
          `  │  to:   ${phone}\n` +
          `  │  code: ${code}\n` +
          `  └─ good for ${String(minutes)} minutes\n`,
      );
      return Promise.resolve();
    },
  };
}
