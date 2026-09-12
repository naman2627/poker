import { z } from 'zod';

/**
 * The auth vocabulary, shared by the API and the web client.
 *
 * The phone number is the identity: it is mandatory, unique, and the only thing
 * a login needs. Email is optional and exists for account recovery later.
 */

/** E.164, as the server normalised it: a leading + and 8-15 digits. */
export const E164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'phone must be in E.164 format, for example +14155552671');

/** What a client may send: anything libphonenumber-js can read. */
export const PhoneInputSchema = z.string().trim().min(4).max(24);

export const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'the code is six digits');

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, 'a display name needs at least two characters')
  .max(24, 'a display name is at most 24 characters');

export const PublicUserSchema = z.object({
  id: z.uuid(),
  phone: E164PhoneSchema,
  phoneVerified: z.boolean(),
  email: z.email().nullable(),
  emailVerified: z.boolean(),
  /** Empty until the player has been through /auth/profile. */
  displayName: z.string(),
  avatarSeed: z.string().nullable(),
  /**
   * False until a display name is set. A player without a complete profile has
   * an account and a token, but may not join a table.
   */
  profileComplete: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const OtpRequestBodySchema = z.object({ phone: PhoneInputSchema });
export type OtpRequestBody = z.infer<typeof OtpRequestBodySchema>;

export const OtpRequestResponseSchema = z.object({
  requestId: z.uuid(),
  expiresInSec: z.number().int().positive(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

export const OtpVerifyBodySchema = z.object({
  requestId: z.uuid(),
  code: OtpCodeSchema,
});
export type OtpVerifyBody = z.infer<typeof OtpVerifyBodySchema>;

export const SessionResponseSchema = z.object({
  accessToken: z.string(),
  expiresInSec: z.number().int().positive(),
  user: PublicUserSchema,
  isNewUser: z.boolean(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const ProfileBodySchema = z.object({
  displayName: DisplayNameSchema,
  email: z.email().optional(),
});
export type ProfileBody = z.infer<typeof ProfileBodySchema>;

export const UserResponseSchema = z.object({ user: PublicUserSchema });
export type UserResponse = z.infer<typeof UserResponseSchema>;
