import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/node_modules/', 'client/dist/'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'e2e/**/*.js', '*.js', 'client/vite.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    ...reactHooks.configs.flat.recommended,
  },
  prettier,
];
