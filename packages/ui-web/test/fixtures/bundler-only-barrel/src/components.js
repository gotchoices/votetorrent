/**
 * Fixture positive control — the bundler-only `./components` barrel. This
 * `./FixtureProbe.js` specifier resolves to `./FixtureProbe.tsx` only under a
 * bundler's extension probing; there is deliberately no `FixtureProbe.js` on
 * disk. Importing this file under plain Node throws `ERR_MODULE_NOT_FOUND` —
 * that throw is the measured behaviour package-shape.test.mjs's rung 1 pins.
 */
export { FixtureProbe } from './FixtureProbe.js';
