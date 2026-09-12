import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Everything under test here is pure: the patch reducer, the slider maths,
    // the seat geometry, the OTP box behaviour. No DOM, so no DOM environment.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
