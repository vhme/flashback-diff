import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      eqeqeq: 'error',
      curly: ['error', 'multi-line'],
      '@typescript-eslint/no-floating-promises': 'off',
    },
  }
);
