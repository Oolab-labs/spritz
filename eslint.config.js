'use strict';

// Lint config. Deliberately narrow: this repo has ~250KB of working, heavily-commented code that
// nobody is going to restyle, so style rules are off and only rules that catch REAL defects are on.
// A lint run that reports 4,000 quote-style complaints gets ignored, and then it catches nothing.
//
// The three process boundaries have genuinely different globals — main is Node, renderer is a
// browser with no Node at all (contextIsolation), preload is both — so they are configured
// separately. Getting this wrong is itself a bug class: referencing `require` in the renderer
// throws at runtime, and only the right globals list will flag it.

const globals = require('globals');

const rules = {
  // --- real defects ---
  'no-undef': 'error',                 // catches renderer code reaching for Node, and typos
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-await-in-loop': 'off',           // deliberate in several sequential device probes
  // Async correctness — the buffering-ring bug was exactly this class of mistake: state read
  // before an await, acted on after, by which time events had already changed it.
  'no-async-promise-executor': 'error',
  // WARN, not error, and deliberately so. It currently flags five pre-existing spots (lanserver
  // `bytes`/`scanning`, torrent `WT`/`active`, renderer `debug.textContent`). They are unreviewed,
  // not known-good — but they predate this config, and turning them into errors on day one would
  // mean landing a lint setup that fails immediately, which is how lint setups get switched off.
  // Triage them, then promote this to error.
  'require-atomic-updates': 'warn',
  // OFF: every hit is `return resolve(x)` used as an early exit. The return value is discarded and
  // the idiom is used consistently throughout main.js. Real rule, no real defects here.
  'no-promise-executor-return': 'off',
  // --- style: off on purpose (see header) ---
  'no-empty': 'off',                   // `catch (e) {}` is used throughout as deliberate best-effort
};

module.exports = [
  {
    ignores: ['node_modules/**', 'native/**/build/**', 'dist/**', 'out/**', 'vendor/**', 'bin/**'],
  },
  {
    // Main process: Node, CommonJS.
    files: ['src/main/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // Preload: Node require + a browser-ish window, bridging the two.
    files: ['src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules,
  },
  {
    // Renderer: browser only. No require, no process, no Buffer — contextIsolation is on and
    // nodeIntegration is off, so anything Node-shaped here is a runtime crash waiting to happen.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, soda: 'readonly' },
    },
    rules,
  },
];
