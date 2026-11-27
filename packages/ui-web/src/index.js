/**
 * @votetorrent/ui-web — the `.` barrel.
 *
 * Binding rule (D-16, mirrors apps/VoteTorrentDashboard/src/i18n/copy.js's
 * contract-header idiom): this file, and everything it transitively imports,
 * MUST be plain JavaScript that plain Node can resolve with no bundler. The
 * tier-1 gate in every web workspace consuming this package (the dashboard
 * today, apps/VoteTorrentPublic once 53-06 lands) runs under
 * `node --test` with no bundler in front of it. Anything `.tsx`, or anything
 * that transitively imports a `.tsx` file, belongs behind the separate
 * `./components` subpath (see src/components.js), never here.
 *
 * `copy.js` (the shared copy table, D-05/D-09/D-10/D-11) landed in 53-04 and is
 * re-exported below. `lifecycle/election-phase.js` landed in 53-05
 * (D-01/D-02/D-07) but is deliberately NOT re-exported here -- see below.
 *
 * Do not merge this barrel with `./components` — the split under `./exports`
 * in package.json is what makes `ERR_MODULE_NOT_FOUND` the correct, gated
 * behaviour for a `.tsx` re-export reached from plain Node, rather than a
 * silent success that only breaks a consumer at build/typecheck time.
 *
 * `election-phase.js`'s only external dependency is
 * `@votetorrent/vote-engine/browser` -- a database engine. Re-exporting it
 * through THIS barrel would load that engine in every tier-1 process that
 * imports `COPY` (measured 0.30-0.44s vs 0.02s bare) for the benefit of only
 * two bundled `.tsx` consumers. It instead lives behind its own plain-JS
 * `./lifecycle` exports entry (package.json) -- still Node-importable with
 * no bundler, just not charged to every consumer of this barrel.
 */

export { COPY, t } from './copy.js';
