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

  // @poker/shared ships compiled ESM, which `next build` resolves through the
  // pnpm symlink quite happily. A serverless deploy is the harder case: the
  // function is assembled from traced files, and a dependency reached through a
  // symlink into a sibling workspace package is exactly what tracing misses —
  // the build goes green and the first request dies on a missing module.
  // Transpiling it compiles the package into the bundle, so there is nothing
  // left to resolve at runtime.
  transpilePackages: ['@poker/shared'],
};

export default nextConfig;
