import type { AppConfig } from '../config';

/**
 * Delivering a one-time code.
 *
 * A route handler never sees one of these: it talks to the OTP service, which
 * holds the provider. Swapping msg91 for twilio is an env variable, not a code
 * change anywhere above this folder.
 */
export interface OtpMessage {
  /** E.164. */
  readonly phone: string;
  /** Plaintext, in memory only, for exactly as long as this call takes. */
  readonly code: string;
  readonly expiresInSec: number;
}

export interface SmsProvider {
  /** A name for logs. Never include the code in anything you log here. */
  readonly name: 'console' | 'msg91' | 'twilio';
  sendOtp(message: OtpMessage): Promise<void>;
}

export class SmsDeliveryError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'SmsDeliveryError';
    this.provider = provider;
  }
}

/** Reads SMS_PROVIDER and builds the one it names. */
export async function createSmsProvider(config: AppConfig): Promise<SmsProvider> {
  switch (config.SMS_PROVIDER) {
    case 'console': {
      const { createConsoleSmsProvider } = await import('./console-provider');
      return createConsoleSmsProvider();
    }
    case 'msg91': {
      const { createMsg91SmsProvider } = await import('./msg91-provider');
      return createMsg91SmsProvider(config);
    }
    case 'twilio': {
      const { createTwilioSmsProvider } = await import('./twilio-provider');
      return createTwilioSmsProvider(config);
    }
  }
}
