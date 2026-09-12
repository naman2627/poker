import type { AppConfig } from '../config';
import { SmsDeliveryError, type OtpMessage, type SmsProvider } from './provider';

const ENDPOINT = 'https://control.msg91.com/api/v5/flow/';

/**
 * MSG91, the usual choice for Indian numbers.
 *
 * The code travels in the request body to MSG91 and nowhere else: it is not
 * logged here, and an error from the API is reported without echoing it back.
 */
export function createMsg91SmsProvider(config: AppConfig): SmsProvider {
  const apiKey = config.SMS_API_KEY;
  const senderId = config.SMS_SENDER_ID;
  if (!apiKey || !senderId) {
    throw new Error('SMS_PROVIDER=msg91 needs SMS_API_KEY and SMS_SENDER_ID');
  }

  return {
    name: 'msg91',
    async sendOtp({ phone, code }: OtpMessage): Promise<void> {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authkey: apiKey,
        },
        body: JSON.stringify({
          template_id: senderId,
          // MSG91 wants the number without the leading +.
          recipients: [{ mobiles: phone.replace(/^\+/, ''), OTP: code }],
        }),
      });

      if (!response.ok) {
        throw new SmsDeliveryError('msg91', `msg91 answered ${String(response.status)}`);
      }
    },
  };
}
