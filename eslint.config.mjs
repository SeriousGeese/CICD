import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The .ts specs carry type annotations, which js.configs.recommended's
    // default parser cannot read — it fails with a bare "Unexpected token :"
    // that looks like a syntax error in the test rather than a missing parser.
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // TS's own checker owns undefined-variable and unused-variable analysis
      // here; the base rules do not understand type-only positions and would
      // flag imported types as unused.
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
