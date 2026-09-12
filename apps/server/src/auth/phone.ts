import parsePhoneNumberFromString from 'libphonenumber-js';
import { AuthError } from './errors';

/**
 * Normalise anything a client sends into E.164, or refuse it.
 *
 * The stored phone number is the identity, so there is exactly one spelling of
 * it: `+14155552671`, never `(415) 555-2671` and never `04155552671`. A number
 * that libphonenumber cannot both parse and call valid does not get an account.
 */
export function normalizePhone(input: string): string {
  const parsed = parsePhoneNumberFromString(input.trim());
  if (!parsed || !parsed.isValid()) {
    throw AuthError.invalidInput('that does not look like a phone number we can send an SMS to');
  }
  return parsed.number;
}
