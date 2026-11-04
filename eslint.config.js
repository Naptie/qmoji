import prettier from 'eslint-config-prettier';
import js from '@eslint/js';
import { includeIgnoreFile } from '@eslint/compat';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));
const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default ts.config(
  includeIgnoreFile(gitignorePath),
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {}
  },
  {
    // Type-aware rules. These need type information, so they are configured
    // separately from the plain recommended set above, and only for
    // TypeScript sources — the config file itself is plain JavaScript.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tests/tsconfig.json', './scripts/tsconfig.json'],
        tsconfigRootDir
      }
    },
    rules: {
      // A promise that nobody awaits is a bug waiting to happen: on Node >= 15
      // an unhandled rejection terminates the process, and this service is
      // started with `Restart=on-failure`. This rule is what would have
      // caught the `images.map(async ...)` in the save path.
      '@typescript-eslint/no-floating-promises': 'error',
      // Passing an async function where a void callback is expected silently
      // drops the promise.
      '@typescript-eslint/no-misused-promises': 'error',
      // `await` on something that is not thenable is always a mistake.
      '@typescript-eslint/await-thenable': 'error'
    }
  },
  {
    // `test()` returns a promise that the test runner owns; awaiting it here
    // would serialise the whole suite.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  }
);
