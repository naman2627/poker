export const OTP_LENGTH = 6;

/**
 * What six boxes should contain after something was typed or pasted into one
 * of them.
 *
 * People paste codes far more often than they type them, and they paste all
 * sorts of things: "424242", "424 242", "Your code is 424242". Everything that
 * is not a digit is dropped, and the digits fill forward from the box that
 * received them, so a paste anywhere fills the whole row.
 */
export function applyOtpInput(
  digits: readonly string[],
  index: number,
  raw: string,
): { digits: string[]; caret: number } {
  const incoming = raw.replace(/\D/g, '').slice(0, OTP_LENGTH);
  const next = Array.from({ length: OTP_LENGTH }, (_unused, i) => digits[i] ?? '');

  if (incoming === '') {
    next[index] = '';
    return { digits: next, caret: index };
  }

  let cursor = index;
  for (const digit of incoming) {
    if (cursor >= OTP_LENGTH) break;
    next[cursor] = digit;
    cursor += 1;
  }

  return { digits: next, caret: Math.min(cursor, OTP_LENGTH - 1) };
}

/** Backspace on an empty box steps back and clears the one before it. */
export function applyOtpBackspace(
  digits: readonly string[],
  index: number,
): { digits: string[]; caret: number } {
  const next = Array.from({ length: OTP_LENGTH }, (_unused, i) => digits[i] ?? '');

  if (next[index] !== '') {
    next[index] = '';
    return { digits: next, caret: index };
  }

  const previous = Math.max(0, index - 1);
  next[previous] = '';
  return { digits: next, caret: previous };
}

export function otpCode(digits: readonly string[]): string {
  return digits.join('');
}

export function isOtpComplete(digits: readonly string[]): boolean {
  return digits.length === OTP_LENGTH && digits.every((digit) => /^\d$/.test(digit));
}

export function emptyOtp(): string[] {
  return Array.from({ length: OTP_LENGTH }, () => '');
}
