import type { AppConfig } from '../config';
import { SmsDeliveryError, type OtpMessage, type SmsProvider } from './provider';

/**
 * Twilio, for everywhere else.
 *
 * SMS_API_KEY carries `accountSid:authToken` and SMS_SENDER_ID is the sending
 * number, so no extra environment variables are needed for one more provider.
 */
export function createTwilioSmsProvider(config: AppConfig): SmsProvider {
  const credentials = config.SMS_API_KEY;
  const from = config.SMS_SENDER_ID;
  if (!credentials || !from) {
    throw new Error('SMS_PROVIDER=twilio needs SMS_API_KEY ("sid:token") and SMS_SENDER_ID');
  }

  const [accountSid, authToken] = credentials.split(':');
  if (!accountSid || !authToken) {
    throw new Error('SMS_API_KEY for twilio must be "accountSid:authToken"');
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return {
    name: 'twilio',
    async sendOtp({ phone, code, expiresInSec }: OtpMessage): Promise<void> {
      const minutes = Math.round(expiresInSec / 60);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: phone,
          From: from,
          Body: `${code} is your poker code. It expires in ${String(minutes)} minutes.`,
        }),
      });

      if (!response.ok) {
        throw new SmsDeliveryError('twilio', `twilio answered ${String(response.status)}`);
      }
    },
  };
}
