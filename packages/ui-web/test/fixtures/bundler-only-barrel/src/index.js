/**
 * Fixture benign control — the plain-JS `.` barrel. Plain Node must import
 * this fine; it is the counterpart proving package-shape.test.mjs's rung 1
 * (the bundler-only barrel positive control) measures resolution behaviour
 * rather than firing on any fixture path at all.
 */
export const FIXTURE_PLAIN_JS_SENTINEL = 'fixture-plain-js-sentinel';
