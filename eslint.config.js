// Flat ESLint config for every TS workspace.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.claude/**', '**/node_modules/**', '**/dist/**', 'refs/**', 'target/**', '**/gen/**', 'worldgen/pkg/**', 'client/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', fetch: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', performance: 'readonly', __dirname: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
