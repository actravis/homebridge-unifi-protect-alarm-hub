// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Type-aware linting, for src only — the tests are plain .mjs and aren't in the TS program.
    // Not the full `recommendedTypeChecked` preset: these four are the rules that catch bugs the
    // compiler can't. `no-floating-promises` especially, because this codebase deliberately
    // fire-and-forgets async work (`void this.syncCameras()`), and an unhandled rejection from
    // one of those calls takes the whole Homebridge process down.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    // Tests are plain Node ESM (run by `node --test`), not TypeScript in the src program.
    // Without declaring the runtime globals, linting them is all false `no-undef` noise.
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setImmediate: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  { ignores: ['dist/', 'node_modules/'] },
);
