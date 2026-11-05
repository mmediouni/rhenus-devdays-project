import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'always']
    }
  },
  { files: ['content/content.js'], languageOptions: { sourceType: 'script' } },
  { files: ['tests/**', 'eslint.config.js'], languageOptions: { globals: globals.node } }
];
