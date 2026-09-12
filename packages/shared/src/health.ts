import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
