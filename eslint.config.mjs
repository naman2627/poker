// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

/**
 * The single ESLint config for the whole monorepo. Every workspace runs
 * `eslint .`; ESLint walks up to this file. Do not add per-package configs.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Repo-wide rules.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',

      // House rule: randomness is injected, never ambient. See CLAUDE.md.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Math.random is banned. Take randomness from the injected Rng interface (packages/engine).',
        },
      ],
    },
  },

  // packages/engine is a pure rules engine: no I/O, no network, no Node
  // built-ins except node:crypto behind the Rng interface.
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'net', 'os', 'child_process'],
              message:
                'packages/engine must stay pure. The only permitted Node built-in is node:crypto, inside rng.ts, behind the Rng interface.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/engine/src/rng.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Node processes.
  {
    files: ['apps/server/**/*.ts', '**/*.config.{ts,mts,js,mjs}', 'tooling/**/*.{ts,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Next.js app.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Tests may reach for Node globals.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
);
