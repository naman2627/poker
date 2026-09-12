import { describe, expect, it } from 'vitest';
import { applyOtpBackspace, applyOtpInput, emptyOtp, isOtpComplete, otpCode } from '../lib/otp';

describe('applyOtpInput', () => {
  it('takes one digit and moves on', () => {
    const { digits, caret } = applyOtpInput(emptyOtp(), 0, '4');
    expect(otpCode(digits)).toBe('4');
    expect(caret).toBe(1);
  });

  it('spreads a pasted code across every box', () => {
    const { digits, caret } = applyOtpInput(emptyOtp(), 0, '424242');
    expect(otpCode(digits)).toBe('424242');
    expect(caret).toBe(5);
    expect(isOtpComplete(digits)).toBe(true);
  });

  it('throws away everything that is not a digit', () => {
    // People paste "Your code is 424 242" straight out of a text message.
    const { digits } = applyOtpInput(emptyOtp(), 0, 'Your code is 424 242');
    expect(otpCode(digits)).toBe('424242');
  });

  it('fills forward from the box that was pasted into', () => {
    const { digits } = applyOtpInput(['9', '', '', '', '', ''], 2, '42');
    expect(digits).toEqual(['9', '', '4', '2', '', '']);
  });

  it('ignores anything past the sixth digit', () => {
    const { digits } = applyOtpInput(emptyOtp(), 0, '4242429999');
    expect(otpCode(digits)).toBe('424242');
  });

  it('clears the box when the input is emptied', () => {
    const { digits, caret } = applyOtpInput(['4', '2', '', '', '', ''], 1, '');
    expect(digits).toEqual(['4', '', '', '', '', '']);
    expect(caret).toBe(1);
  });
});

describe('applyOtpBackspace', () => {
  it('clears the box it is in when there is something in it', () => {
    const { digits, caret } = applyOtpBackspace(['4', '2', '', '', '', ''], 1);
    expect(digits).toEqual(['4', '', '', '', '', '']);
    expect(caret).toBe(1);
  });

  it('steps back and clears the one before when the box is empty', () => {
    const { digits, caret } = applyOtpBackspace(['4', '2', '', '', '', ''], 2);
    expect(digits).toEqual(['4', '', '', '', '', '']);
    expect(caret).toBe(1);
  });

  it('does not run off the start of the row', () => {
    const { caret } = applyOtpBackspace(emptyOtp(), 0);
    expect(caret).toBe(0);
  });
});

describe('isOtpComplete', () => {
  it('is true only for six digits', () => {
    expect(isOtpComplete(['4', '2', '4', '2', '4', '2'])).toBe(true);
    expect(isOtpComplete(['4', '2', '4', '2', '4', ''])).toBe(false);
    expect(isOtpComplete(['4', '2', '4', '2', '4', 'x'])).toBe(false);
  });
});
