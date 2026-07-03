import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// ESLint flat config for tidal-conductor.
//
// Policy:
// - Node/TS only (no React/Next/JSX). No front-end plugins.
// - Enforce the project conventions mechanically: no for/while, no let, no Math.random (use runSeeded / crypto).
// - Type-aware rules (no-floating-promises, no-unsafe-* etc.) are errors: the code base is clean and
//   CI keeps it that way.
// - Formatting is left entirely to Prettier; conflicting rules are disabled by eslint-config-prettier (always last).

export default tseslint.config(
  // Target files
  { name: 'files', files: ['**/*.{js,mjs,ts}'] },

  // Ignores (data assets, generated files, dependencies)
  {
    name: 'ignores',
    ignores: [
      'node_modules/**',
      'sessions/**',
      'ghci/**',
      'schema/**',
      'manifests/**',
      'plans/**',
      'training/**',
      '*.tsbuildinfo',
    ],
  },

  // Base: ESLint recommended + typescript-eslint recommended (the layer that needs no type information)
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Type information: resolve the nearest tsconfig.json automatically via projectService
  {
    name: 'languageOptions',
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project conventions + custom rules
  {
    name: 'ai-conventions',
    rules: {
      // --- Mechanical enforcement of project conventions (error) ---
      // No for/while (functional style). Use map/filter/reduce.
      // No let. prefer-const misses "a let that is reassigned", so the syntax itself is banned.
      'no-restricted-syntax': [
        'error',
        {
          selector: "VariableDeclaration[kind='let']",
          message:
            'Use const instead of let (if reassignment is needed, rethink the design; disable with a reason only where truly necessary).',
        },
        {
          selector: 'ForStatement',
          message: 'Do not use for loops; use map/filter/reduce etc. (functional style).',
        },
        {
          selector: 'ForOfStatement',
          message: 'Do not use for-of; use map/filter/forEach etc. (functional style).',
        },
        {
          selector: 'ForInStatement',
          message: 'Do not use for-in; use Object.keys/entries + map etc. (functional style).',
        },
        {
          selector: 'WhileStatement',
          message: 'Do not use while; use recursion or functional iteration.',
        },
        {
          selector: 'DoWhileStatement',
          message: 'Do not use do-while; use recursion or functional iteration.',
        },
      ],
      // Randomness goes through runSeeded. Where true non-determinism is required (e.g. experiment assignment), use node:crypto.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Use runSeeded from rand.ts for randomness. Where true non-determinism is required, use randomInt from node:crypto.',
        },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
      // Duplicate imports of one module (ESLint core; eslint-plugin-import does not support ESLint 10 yet).
      // A separate `import type` next to a value import is allowed — consistent-type-imports (warn) nudges toward inline
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],

      // --- General rules ---
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Empty functions (no-op callbacks etc.) are allowed
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'off',

      // --- Type-aware rules (error: the code base is clean, and CI keeps it so) ---
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Prefer the inline form for type-only imports (auto-fixable: pnpm lint:fix)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // The config file itself (eslint.config.mjs) is outside the tsconfig include.
  // Drop the type-information link and disable the type-aware rules (left enabled they fail with "requires type information").
  {
    name: 'config-files',
    files: ['*.mjs', '*.js', 'scripts/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
    },
  },

  // Disable rules that conflict with Prettier (always last)
  eslintConfigPrettier,
)
