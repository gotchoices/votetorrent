/**
 * react-identity.js — the package-side React reference publisher (D-19).
 *
 * `packageReactIdentity()` returns a frozen snapshot of the copy of React
 * THIS PACKAGE resolved, so a consuming app's browser gate can compare it
 * against the app's OWN copy and detect the one failure mode this whole
 * package shape exists to prevent: two React module instances loaded into
 * one page. Reached only through `@votetorrent/ui-web/components` (never
 * the plain `.` barrel) — this module imports `react`, which belongs on the
 * bundler-only tier alongside every other `.tsx` re-export in
 * `components.js`; putting it on the plain barrel would put a React import
 * in the path the bundler-less `node --test` tier imports.
 *
 * WHY THE RETURNED REFERENCES ARE THE INNER ONES, NOT A NAMESPACE COMPARISON
 * AND NOT THE VERSION STRING (spike 089's measured findings):
 *
 * - A consumer comparing two `import * as R from 'react'` NAMESPACE OBJECTS
 *   gets a FALSE NEGATIVE under some bundling paths — esbuild can hand
 *   different importers different namespace WRAPPERS around one underlying
 *   module, so `nsA === nsB` can read false even when there is genuinely one
 *   React underneath. `useState` (a plain function value on that module) and
 *   the client-internals holder below survive that wrapper difference,
 *   because both are the SAME reference regardless of which wrapper handed
 *   them out.
 * - A consumer comparing the `version` string gets a FALSE POSITIVE — spike
 *   089 measured both copies reporting the identical `19.0.0` string in
 *   EVERY broken variant it produced (two real, distinct React module
 *   instances, each built from the same `19.0.0` release). `version` is
 *   carried on the returned object only as a decoy, so a consumer can show
 *   it stays true even when the real measures below read false; it must
 *   never be compared for a pass/fail verdict.
 *
 * `useState` is the one hook this package's designated hook-calling
 * component (`DetailsToggle`, D-12) actually calls — it is not an arbitrary
 * choice; it is the specific function reference a duplicate React would
 * make into a null dispatcher read (`Cannot read properties of null
 * (reading 'useState')`). `internals` is React 19's client internals
 * holder — the object the hook dispatcher itself is threaded through — read
 * defensively (`null` rather than a throw) because its exact property name
 * is an internal React implementation detail with no public typing.
 * `reactNamespace` is exposed ONLY so a consumer can additionally compute
 * the decoy namespace-identity comparison described above for its own
 * observability log; like `version`, it must never be compared for a
 * pass/fail verdict — `useState`/`internals` are the sound measures.
 */
import * as ReactNamespace from 'react';

const CLIENT_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * @returns {Readonly<{ useState: Function, internals: unknown, version: string, reactNamespace: object }>}
 */
export function packageReactIdentity() {
	let internals = null;
	try {
		internals = /** @type {any} */ (ReactNamespace)[CLIENT_INTERNALS_KEY] ?? null;
	} catch {
		internals = null;
	}
	return Object.freeze({
		useState: ReactNamespace.useState,
		internals,
		version: ReactNamespace.version,
		reactNamespace: ReactNamespace,
	});
}
