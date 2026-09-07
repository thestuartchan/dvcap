import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// ONE SET OF GLOBALS FOR THREE DIFFERENT RUNTIMES WAS THE BUG.
//
// This declared `globals.browser` for `**/*.{js,jsx}` — every file in the repo — so every
// `process.env` in api/ and lib/ and every `Buffer` in a GitHub-store write was reported as an
// undefined variable. 55 of the 167 errors were that, and none of them was real.
//
// The cost was not the noise, it was what the noise hid: a linter that cries wolf on the correct
// use of `process` is a linter nobody reads, and the react-hooks findings underneath it went
// unlooked-at for months. Scope the globals to where each file actually runs and what is left is
// what is actually wrong.
// A DELIBERATE PLACEHOLDER IS NOT DEAD CODE. Fifteen of the unused-variable findings were `_` —
// the conventional name for "this position in the destructuring exists and I do not want it" — and
// one was a caught error deliberately swallowed. Reporting those trains the reader to skim the
// rule, which is how the genuinely unused imports underneath them survived.
const UNUSED = ['error', {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^(_|e|err)$',
}];

export default defineConfig([
  globalIgnores(['dist']),

  // The browser bundle. React rules belong here and only here — api/ and lib/ have no components,
  // and react-refresh's "only export components" rule is meaningless in a module that exports none.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-unused-vars': UNUSED },
  },

  // Serverless routes, the edge middleware, build scripts and tests. Node, not a browser.
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'test/**/*.mjs', 'middleware.js', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': UNUSED },
  },

  // ISOMORPHIC ON PURPOSE. lib/ is imported by both halves — lib/price.js formats a card on the
  // server and a table in the browser, lib/hyperliquid.js reads process.env in a route and is
  // imported by the console for its pure functions. Declaring both is the honest description of
  // where this code runs; narrowing it to one would make correct code fail the check.
  {
    files: ['lib/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': UNUSED },
  },
])
