/**
 * @votetorrent/ui-web — the `./components` barrel.
 *
 * Binding rule (D-16, counterpart to src/index.js's contract): every
 * re-export in this file uses a `./components/Name.js` specifier that
 * resolves to a same-named `./components/Name.tsx` file on disk. Vite (and
 * every bundler in this repo) resolves that `.js` specifier to the `.tsx`
 * file via its `moduleResolution: "bundler"` extension-probing; plain Node
 * does NOT perform that probe and throws `ERR_MODULE_NOT_FOUND` importing
 * this subpath directly. That throw is the intended, gated behaviour — proof
 * that a consumer never reaches this subpath from a bundler-less `node --test`
 * tier — not a bug to be "fixed" by merging this barrel into `./index.js`.
 *
 * `AdvisoryDisclosure`, `LifecyclePill` and `DetailsToggle` landed in 53-05
 * (D-01/D-02/D-07/D-12), each behind its own `./components/Name.js`
 * specifier backed by a same-named `.tsx` file — never a `.js` file on disk,
 * or the ERR_MODULE_NOT_FOUND proof stops being real. Only the runtime
 * value is re-exported here, not the prop-type interfaces: this file has a
 * plain `.js` extension and a bundler's default JS/JSX loader does not parse
 * TypeScript-only syntax such as `export type { ... }`, so a type-only
 * re-export would break parsing rather than merely being redundant.
 *
 * `packageReactIdentity` (53-09, D-19) is NOT a shared component — it is the
 * package-side React reference publisher the D-19 identity gate compares a
 * consumer's own React against. It lives at `./react-identity.js`, not
 * `./components/Name.js`, and deliberately does not match
 * `run-ui-gates.mjs`'s `parseComponentExportNames` pattern (which only
 * matches the `./components/Name.js` specifier form): it must never be
 * treated as a "shared component" subject to the `shared-components-mounted`
 * rung's mount-and-render check. It belongs on this bundler-only tier for
 * the same reason as the three components above — it imports `react`.
 *
 * `BarSeries`, `StackedBarSeries`, `TimeSeries` and `Meter` (60-03) sit under
 * `./charts/` rather than `./components/` — a second, sibling subfolder of
 * this same barrel, backed by the same same-named-`.tsx`-on-disk contract.
 * `run-ui-gates.mjs`'s `parseComponentExportNames` and
 * `ui-gate-harness.test.mjs` test (7) both match ONLY the `./components/Name.js`
 * specifier form, so neither of those two forces a browser-harness mount for
 * the chart half — `packages/ui-web/test/charts-contract.test.mjs`'s barrel-
 * lockstep rung is what keeps `./charts/` in step with this file instead.
 */

export { AdvisoryDisclosure } from './components/AdvisoryDisclosure.js';
export { LifecyclePill } from './components/LifecyclePill.js';
export { DetailsToggle } from './components/DetailsToggle.js';
export { packageReactIdentity } from './react-identity.js';
export { BarSeries } from './charts/BarSeries.js';
export { StackedBarSeries } from './charts/StackedBarSeries.js';
export { TimeSeries } from './charts/TimeSeries.js';
export { Meter } from './charts/Meter.js';
