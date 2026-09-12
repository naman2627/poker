import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Pin tracing to the monorepo root; without it Next walks up past the repo
  // looking for a lockfile and guesses wrong.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),

  // Linting is a Turborepo task (`pnpm lint`) against the single root ESLint
  // config, so `next build` does not need to run its own pass.
  eslint: { ignoreDuringBuilds: true },

  // @poker/shared ships compiled ESM, so no transpilePackages entry is needed.
};

export default nextConfig;
