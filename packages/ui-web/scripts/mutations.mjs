#!/usr/bin/env node
/**
 * mutations.mjs — the shared BUILD-TIME mutation machinery for the two D-20
 * negative controls (`--prove-no-dedupe`, `--prove-token-missing` in
 * `run-ui-gates.mjs`). Imports nothing outside `node:` builtins and Vite's
 * own `mergeConfig` — this module is loaded by a Vite CONFIG file running in
 * a Node process, never by a bundler, so it lives on the plain-JS tier
 * alongside the package's `.` barrel (see `package.json`'s `./mutations`
 * export subpath), never behind `./components`.
 *
 * WHY BUILD TIME, NEVER RUNTIME OR POST-BUILD: spike 089 measured a runtime
 * React-identity check as false-negative, because esbuild hands different
 * importers different namespace WRAPPERS around one underlying module. Every
 * mutation here is applied to a Vite CONFIG before a real `vite build` runs
 * — never to an already-built `dist/`-shaped directory, and never injected
 * into a page after it loads. `resolveMutation()`'s fail-closed throw is
 * what makes a mutant config unable to become a second, quietly-healthy
 * shipping path: without `UI_GATE_MUTATION` naming a real mutation, there is
 * no build at all.
 *
 * `.mutation-report.json`, written into the mutant build's own `outDir` by
 * `writeMutationReportPlugin`/`stripTokensPlugin`, is what lets the runner
 * (`readMutationReport`) prove the mutation actually fired BEFORE computing
 * any verdict — a machine-readable fact, never a log-scrape.
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeConfig } from 'vite';

/**
 * The frozen mutation-name set — the single source of the valid set.
 * Nothing else in this module or its consumers may hard-code a mutation
 * name outside this array.
 *
 * 56-13 appends the last two. Its own plan text anticipated a THREE-element
 * list (`no-dedupe`, `token-missing`, `gap-cues-flattened`); `pill-retone-reverted`
 * landed from 56-03 in between, so the two new names are APPENDED to the
 * four that exist rather than replacing a fourth that is load-bearing for a
 * shipped control (`gate:prove-pill-retone-reverted`).
 * @type {readonly ['no-dedupe', 'token-missing', 'gap-cues-flattened', 'pill-retone-reverted', 'cadre-patch-reverted', 'notify-disabled']}
 */
export const MUTATIONS = Object.freeze(
	/** @type {const} */ ([
		'no-dedupe',
		'token-missing',
		'gap-cues-flattened',
		'pill-retone-reverted',
		'cadre-patch-reverted',
		'notify-disabled',
	]),
);

/**
 * Reads `process.env.UI_GATE_MUTATION` and throws when it is unset, empty,
 * or not a member of `MUTATIONS` — the fail-closed rule that keeps a
 * `vite.mutant.config.ts` from ever quietly emitting a healthy bundle.
 * @returns {string}
 */
export function resolveMutation() {
	const raw = process.env.UI_GATE_MUTATION;
	if (!raw || !MUTATIONS.includes(/** @type {any} */ (raw))) {
		throw new Error(
			`UI_GATE_MUTATION must be set to one of: ${MUTATIONS.join(', ')} — got ${JSON.stringify(raw ?? null)}. ` +
				'A mutant config that ran with no selector could quietly become a second, healthy shipping path; this throw is what stops that.',
		);
	}
	return raw;
}

/**
 * Removes `resolve.dedupe` from `productionConfig` (throwing `MUTATION IS A
 * NO-OP` if it was not there to remove), merges `gateOverrides` onto the
 * result with Vite's own `mergeConfig`, then re-reads the MERGED result's
 * `resolve.dedupe` — throwing `GATE CONFIG SELF-REFERENCE` if the gate
 * overrides re-declared it (53-09's carried-forward finding, made
 * mechanical: a gate config that carries its own `resolve.dedupe` would
 * observe itself rather than the shipped production config, and this
 * mutation would silently fail to reach it).
 *
 * @param {Record<string, any>} productionConfig the app's own resolved production vite config
 * @param {Record<string, any>} gateOverrides the app's own gate-build overrides (NOT pre-merged)
 * @param {string} [productionConfigLabel] a human label for the production config, for error messages only
 * @returns {{ config: Record<string, any>, report: { removedDedupe: string[], selfReference: false } }}
 */
export function applyNoDedupe(productionConfig, gateOverrides, productionConfigLabel = 'the production vite config') {
	const dedupe = productionConfig?.resolve?.dedupe;
	const hasBoth = Array.isArray(dedupe) && dedupe.includes('react') && dedupe.includes('react-dom');
	if (!hasBoth) {
		throw new Error(
			`MUTATION IS A NO-OP: ${productionConfigLabel} does not declare a resolve.dedupe containing both ` +
				`"react" and "react-dom" (found: ${JSON.stringify(dedupe ?? null)}). Removing something that was ` +
				'never there mutates nothing, and a gate run against an unmutated build would falsely report the gate inert.',
		);
	}

	const { resolve: prodResolve, ...restProd } = productionConfig;
	const { dedupe: _removed, ...restResolve } = prodResolve;
	const mutatedProd = Object.keys(restResolve).length > 0 ? { ...restProd, resolve: restResolve } : { ...restProd };

	const merged = mergeConfig(mutatedProd, gateOverrides);
	const mergedDedupe = merged?.resolve?.dedupe;
	if (Array.isArray(mergedDedupe) && mergedDedupe.length > 0) {
		throw new Error(
			`GATE CONFIG SELF-REFERENCE: after removing resolve.dedupe from ${productionConfigLabel}, the merged ` +
				`gate build still carries resolve.dedupe=${JSON.stringify(mergedDedupe)} — the gate overrides ` +
				're-declared it, so this gate build observes its own config rather than the one that actually ships. ' +
				'Remove the resolve block from the gate config so it inherits the production config unchanged.',
		);
	}

	return { config: merged, report: { removedDedupe: dedupe, selfReference: false } };
}

/**
 * A tiny Vite plugin that writes `report` to `<outDir>/.mutation-report.json`
 * once the build finishes — shared plumbing used by the `no-dedupe` mutant
 * config (whose mutation happens at config-authoring time, before any Vite
 * build hook runs, so it needs a plugin purely to persist the report after
 * `emptyOutDir` has already run).
 *
 * @param {Record<string, any>} report
 * @returns {import('vite').Plugin}
 */
export function writeMutationReportPlugin(report) {
	/** @type {string | null} */
	let outDirAbs = null;
	return {
		name: 'ui-web-mutation-write-report',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		closeBundle() {
			if (!outDirAbs) {
				throw new Error('writeMutationReportPlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(path.join(outDirAbs, '.mutation-report.json'), JSON.stringify(report, null, 2));
		},
	};
}

/**
 * Escapes `s` for literal use inside a `RegExp` constructor.
 * @param {string} s
 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one specifier every delivery form below removes a reference to. */
const TOKENS_SPECIFIER = '@votetorrent/ui-web/tokens.css';

/**
 * A Vite plugin, `ui-web-mutation-strip-tokens`, that removes the shared
 * tokens stylesheet REFERENCE from a build — never the file, never its
 * contents. Handles all three delivery forms a consumer could plausibly use
 * (only the CSS `@import` form is actually in use by either app today, per
 * this plan's own read of `app.css`/`index.html`, but the plugin is written
 * against the general contract rather than the one form currently present):
 *   - a JS/TS side-effect import whose specifier is the tokens specifier,
 *     removed in `transform` for `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs` ids;
 *   - a CSS `@import` of the same specifier, removed in `transform` for
 *     `.css` ids;
 *   - an HTML `<link rel="stylesheet">` naming the same specifier, removed
 *     in `transformIndexHtml`.
 *
 * `closeBundle` throws `MUTATION IS A NO-OP` if nothing was ever removed,
 * and otherwise writes `.mutation-report.json` into the build's `outDir`
 * recording `{ mutation: 'token-missing', removals, forms }` — the runner
 * reads this file rather than parsing build stdout.
 *
 * @returns {import('vite').Plugin}
 */
export function stripTokensPlugin() {
	let removals = 0;
	/** @type {Set<string>} */
	const forms = new Set();
	/** @type {string | null} */
	let outDirAbs = null;

	return {
		name: 'ui-web-mutation-strip-tokens',
		// `enforce: 'pre'` (D-20): Vite's own internal CSS handling resolves an
		// `@import` (via PostCSS import resolution) INSIDE its own `transform`
		// hook, inlining the imported file's content before a normal-priority
		// user plugin would ever see the literal `@import` text — measured live
		// against the real app.css: without `enforce: 'pre'` this plugin counted
		// zero removals on a build that still exited 0 (a genuine no-op, caught
		// by this plugin's own `closeBundle` guard, not a false pass). Running
		// `pre` intercepts the raw, unresolved source instead.
		enforce: 'pre',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		transform(code, id) {
			const bareId = id.split('?')[0];
			if (/\.(jsx?|tsx?|mjs|cjs)$/.test(bareId)) {
				const importRe = new RegExp(
					`^[ \\t]*import\\s+['"]${escapeRegExp(TOKENS_SPECIFIER)}['"];?[ \\t]*\\r?\\n?`,
					'gm',
				);
				if (importRe.test(code)) {
					removals += 1;
					forms.add('js-side-effect-import');
					return { code: code.replace(importRe, ''), map: null };
				}
				return null;
			}
			if (bareId.endsWith('.css')) {
				const atImportRe = new RegExp(`@import\\s+['"]${escapeRegExp(TOKENS_SPECIFIER)}['"];?`, 'g');
				if (atImportRe.test(code)) {
					removals += 1;
					forms.add('css-at-import');
					return { code: code.replace(atImportRe, '/* stripped by ui-web-mutation-strip-tokens */'), map: null };
				}
				return null;
			}
			return null;
		},
		transformIndexHtml(html) {
			const linkRe = /<link\b[^>]*href=["'][^"']*tokens\.css[^"']*["'][^>]*>\s*/gi;
			if (linkRe.test(html)) {
				removals += 1;
				forms.add('html-link');
				return html.replace(linkRe, '');
			}
			return html;
		},
		closeBundle() {
			if (removals === 0) {
				throw new Error(
					"MUTATION IS A NO-OP: stripTokensPlugin removed zero references to '@votetorrent/ui-web/tokens.css' " +
						'across the JS-import, CSS-@import and HTML-link forms — the token-missing mutation did not fire.',
				);
			}
			if (!outDirAbs) {
				throw new Error('stripTokensPlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify({ mutation: 'token-missing', removals, forms: [...forms] }, null, 2),
			);
		},
	};
}

/**
 * The gap-card modifier class the public app's stylesheet declares, and the
 * ONE place this module writes it.
 *
 * WHY A CLASS SELECTOR SATISFIES THE OBJECT-LITERAL-PROPERTY-KEY RULE rather
 * than dodging it. That rule exists because esbuild RENAMES bare local
 * bindings, so a `typeof someLocal` probe against a minified bundle is
 * falsely inert — the control passes while proving nothing. The token matched
 * below is a CSS class selector inside a stylesheet, and no bundler renames a
 * class selector: renaming it would break every element that carries the
 * class in the markup. It is stable under minification for exactly the same
 * reason an object-literal property key is, and for the same reason it is a
 * faithful target for a build-time mutation.
 */
const GAP_MODIFIER_CLASS = 'fact-card--gap';

/** What replaces a flattened rule's declaration body. */
const FLATTEN_MARKER = '/* declarations flattened by ui-web-mutation-flatten-gap-cues */';

/**
 * A Vite plugin, `ui-web-mutation-flatten-gap-cues`, that empties the
 * DECLARATION BODY of every CSS rule whose selector list names the gap-card
 * modifier class — leaving the selector and its braces intact.
 *
 * WHY THE BODY AND NEVER THE CLASS NAME. Deleting the class (from the
 * stylesheet or the markup) would produce a page with no gap card at all, and
 * the style-divergence rung would then fail because the pair it compares does
 * not exist — the right rung failing for the wrong reason, which is
 * indistinguishable from a crashed page and proves nothing about styling. With
 * the body emptied, the rule still MATCHES; it simply declares nothing, so the
 * gap card computes the base `.fact-card` values and all three D-11 cues
 * (border style, colour, size) collapse together. One mutation, three cues —
 * which is what makes it a faithful inversion of a rung that requires all
 * three to diverge.
 *
 * `enforce: 'pre'` for the same MEASURED reason `stripTokensPlugin` carries
 * it: Vite's own CSS handling resolves and inlines `@import`s inside its own
 * `transform`, so a normal-priority plugin can be handed post-processed CSS
 * and count zero replacements on a build that still exits 0.
 *
 * STANDING RULE, restated here because this is where it is easiest to break:
 * this runs against SOURCE, before a real `vite build`. It never edits a
 * built `dist/`, and it never injects anything into a page at runtime.
 *
 * `closeBundle` throws `MUTATION IS A NO-OP` on zero replacements, naming the
 * selector it looked for — a no-op is a DIFFERENT verdict from an inert gate
 * and the two must never be reported as the same thing.
 *
 * @returns {import('vite').Plugin}
 */
export function flattenGapCuesPlugin() {
	let replacements = 0;
	/** @type {Set<string>} */
	const selectors = new Set();
	/** @type {string | null} */
	let outDirAbs = null;

	// A leaf rule block: a selector list, then a body carrying no nested
	// `{`. Restricting the body to brace-free text keeps this correct if a
	// stylesheet later grows an at-rule or a nested block — such a wrapper
	// simply is not matched, rather than being silently mangled.
	const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
	// Whole-token match on the class, so `.fact-card--gap-note` (a different
	// class that merely starts the same way) is never flattened.
	const classRe = new RegExp(`\\.${escapeRegExp(GAP_MODIFIER_CLASS)}(?![\\w-])`);

	return {
		name: 'ui-web-mutation-flatten-gap-cues',
		enforce: 'pre',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		transform(code, id) {
			const bareId = id.split('?')[0];
			if (!bareId.endsWith('.css')) return null;
			let touched = false;
			const out = code.replace(ruleRe, (whole, selectorList, body) => {
				if (!classRe.test(selectorList)) return whole;
				if (body.trim() === FLATTEN_MARKER) return whole;
				replacements += 1;
				// The captured "selector list" runs from the previous rule's
				// closing brace, so it carries any comment block sitting above
				// the rule. Strip comments for the REPORT only -- the emitted
				// CSS keeps them verbatim, because a mutation that also deleted
				// documentation would be mutating two things at once.
				selectors.add(
					String(selectorList)
						.replace(/\/\*[\s\S]*?\*\//g, '')
						.trim()
						.replace(/\s+/g, ' '),
				);
				touched = true;
				return `${selectorList}{ ${FLATTEN_MARKER} }`;
			});
			return touched ? { code: out, map: null } : null;
		},
		closeBundle() {
			if (replacements === 0) {
				throw new Error(
					`MUTATION IS A NO-OP: flattenGapCuesPlugin found no CSS rule whose selector list names ".${GAP_MODIFIER_CLASS}", ` +
						'so no declaration body was flattened and the gap-cues-flattened mutation did not fire. A control run against ' +
						'an unmutated build would falsely report the gate inert, which is a different verdict entirely.',
				);
			}
			if (!outDirAbs) {
				throw new Error('flattenGapCuesPlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify(
					{ mutation: 'gap-cues-flattened', removals: replacements, selectors: [...selectors] },
					null,
					2,
				),
			);
		},
	};
}

/**
 * The retoned pill's own class, and the ONE place this module writes it.
 * Declared as a module constant, never inline in a comment, on the identical
 * precedent `GAP_MODIFIER_CLASS` above states for itself: a class selector is
 * stable under minification (no bundler renames it, because renaming would
 * break every element carrying the class in the markup), which is what makes
 * it a faithful target for a build-time mutation.
 */
const PILL_INDETERMINATE_CLASS = 'lifecycle-pill--indeterminate';

/**
 * The PRE-retone declaration body (56-03 Task 1 removed exactly this text
 * from `packages/ui-web/src/components.css`). Declared as a module constant
 * so `revertPillRetonePlugin` restores exactly what was removed, never a
 * paraphrase of it.
 */
const PILL_RETONE_REVERTED_DECLARATIONS = 'color: var(--fail); opacity: 1;';

/**
 * A Vite plugin, `ui-web-mutation-revert-pill-retone`, that REPLACES the
 * DECLARATION BODY of every CSS rule whose selector list names
 * `.lifecycle-pill--indeterminate` with the PRE-retone declarations — the
 * exact inverse of `flattenGapCuesPlugin` above, which EMPTIES a body. This
 * mutation restores rather than empties because the retone rung
 * (`indeterminate-pill-neutral`) asserts a SPECIFIC colour and opacity; an
 * emptied body would fall through to the `.lifecycle-pill` base rule's
 * `color: var(--muted)` — a third colour that is neither `--text` nor
 * `--fail` — and the control would prove nothing about whether the retone
 * specifically reverted to the pre-retone alarm tone.
 *
 * Mirrors `flattenGapCuesPlugin`'s MUTATION SHAPE exactly — the same
 * leaf-rule regex (a selector list plus a brace-free body) and the same
 * whole-token class matcher, so a longer class beginning with the same
 * characters (there is none today, but the rule is general) is never
 * matched — but NOT its hook. `flattenGapCuesPlugin` runs at `transform`,
 * `enforce: 'pre'`, because its target (`.fact-card--gap`) is declared
 * DIRECTLY in the app's own `app.css`. This plugin's target
 * (`.lifecycle-pill--indeterminate`) is declared in
 * `packages/ui-web/src/components.css`, which `app.css` only reaches through
 * a CSS `@import` — measured live: a `transform`-based version, at ANY
 * enforce priority, is handed either the RAW `app.css` payload (`@import`
 * still literal, the target rule not yet present) or, if enforce is not
 * `'pre'`, `app.css`'s FULLY merged content (the target present, but Vite's
 * own import-inlining reads and concatenates the imported file's bytes
 * directly rather than routing them back through a second `transform` call
 * of their own — so a `'pre'` hook never sees a payload that both contains
 * the target rule and is still unbundled). This plugin instead hooks
 * `generateBundle`, which runs once Rollup has produced the final emitted
 * CSS asset with every `@import` already inlined — still inside this SAME
 * `vite build` invocation, still writing into this mutant's own `outDir`,
 * never touching an already-written `dist-gate/` and never injecting
 * anything at runtime.
 *
 * `closeBundle` throws `MUTATION IS A NO-OP` on zero replacements — a
 * control run against an unmutated build would falsely report the gate
 * inert, a different verdict entirely — and otherwise writes
 * `.mutation-report.json` into the build's `outDir` recording
 * `{ mutation: 'pill-retone-reverted', replacements, selectors }`.
 *
 * STANDING RULE, restated here on the identical precedent: this runs against
 * SOURCE, before a real `vite build`. It never edits a built `dist/`, and it
 * never injects anything into a page at runtime.
 *
 * @returns {import('vite').Plugin}
 */
export function revertPillRetonePlugin() {
	let replacements = 0;
	/** @type {Set<string>} */
	const selectors = new Set();
	/** @type {string | null} */
	let outDirAbs = null;

	const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
	const classRe = new RegExp(`\\.${escapeRegExp(PILL_INDETERMINATE_CLASS)}(?![\\w-])`);

	return {
		name: 'ui-web-mutation-revert-pill-retone',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		// `generateBundle`, NOT `transform` (measured live, the reason
		// `flattenGapCuesPlugin`'s own `enforce: 'pre'` note does not
		// transfer here). `.lifecycle-pill--indeterminate` is declared in
		// `packages/ui-web/src/components.css`, which the app's own
		// `app.css` only reaches through a CSS `@import` -- unlike
		// `.fact-card--gap`, which `flattenGapCuesPlugin` matches directly
		// inside `app.css` itself. A measured `transform` trace (id, whether
		// the class name is present in that id's own code) showed `pre`
		// intercepting exactly ONE `.css` id -- `app.css`'s own RAW,
		// UN-INLINED source, still carrying the literal `@import` line --
		// and no second `transform` call ever fires for the imported
		// `components.css` file as its own module: Vite's `@import`
		// resolution reads and inlines the imported file's bytes directly
		// via its OWN internal css-import machinery rather than routing them
		// back through the plugin pipeline's `load`/`transform` hooks. So a
		// `transform` hook, at ANY enforce priority, never sees a single
		// `.css` payload that both contains this rule AND is still
		// unminified/unbundled. `generateBundle` runs once Rollup has
		// produced the FINAL emitted CSS asset -- imports already inlined,
		// still inside this SAME `vite build` invocation, still writing into
		// this mutant's own `outDir`, never touching an already-written
		// `dist-gate/` and never injecting anything at runtime. The
		// mutation's shape is otherwise IDENTICAL to `flattenGapCuesPlugin`:
		// the same leaf-rule regex, the same whole-token class matcher, and
		// the same no-op / report-write discipline.
		generateBundle(_options, bundle) {
			for (const fileName of Object.keys(bundle)) {
				const item = bundle[fileName];
				if (!fileName.endsWith('.css') || item.type !== 'asset') continue;
				const code = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
				let touched = false;
				const out = code.replace(ruleRe, (whole, selectorList, body) => {
					if (!classRe.test(selectorList)) return whole;
					if (body.trim() === PILL_RETONE_REVERTED_DECLARATIONS) return whole;
					replacements += 1;
					// The captured "selector list" runs from the previous rule's
					// closing brace, so it carries any comment block sitting above
					// the rule. Strip comments for the REPORT only -- the emitted
					// CSS keeps them verbatim, on the identical precedent
					// flattenGapCuesPlugin follows.
					selectors.add(
						String(selectorList)
							.replace(/\/\*[\s\S]*?\*\//g, '')
							.trim()
							.replace(/\s+/g, ' '),
					);
					touched = true;
					return `${selectorList}{ ${PILL_RETONE_REVERTED_DECLARATIONS} }`;
				});
				if (touched) item.source = out;
			}
		},
		closeBundle() {
			if (replacements === 0) {
				throw new Error(
					`MUTATION IS A NO-OP: revertPillRetonePlugin found no CSS rule whose selector list names ".${PILL_INDETERMINATE_CLASS}", ` +
						'so no declaration body was reverted and the pill-retone-reverted mutation did not fire. A control run against ' +
						'an unmutated build would falsely report the gate inert, which is a different verdict entirely.',
				);
			}
			if (!outDirAbs) {
				throw new Error('revertPillRetonePlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify({ mutation: 'pill-retone-reverted', replacements, selectors: [...selectors] }, null, 2),
			);
		},
	};
}

/**
 * The one package specifier `redirectCadreCorePlugin` redirects, and the ONE
 * place this module writes it.
 */
const CADRE_CORE_SPECIFIER = '@serfab/cadre-core';

/**
 * Resolve `subpath` (`'.'` or `'./x'`) against a package manifest's own
 * `exports` map, preferring the ESM conditions a Vite build would take, and
 * falling back to `module`/`main` for a manifest with no `exports` map at
 * all. Returns a package-relative path, or `null` when the manifest does not
 * publish that subpath.
 *
 * @param {Record<string, any>} manifest
 * @param {string} subpath
 * @returns {string | null}
 */
function resolveManifestSubpath(manifest, subpath) {
	/** @param {any} node @returns {string | null} */
	const pick = (node) => {
		if (typeof node === 'string') return node;
		if (!node || typeof node !== 'object') return null;
		for (const condition of ['import', 'module', 'browser', 'default']) {
			if (condition in node) {
				const picked = pick(node[condition]);
				if (picked) return picked;
			}
		}
		return null;
	};
	const exportsMap = manifest?.exports;
	if (exportsMap && typeof exportsMap === 'object' && !Array.isArray(exportsMap)) {
		if (subpath in exportsMap) return pick(exportsMap[subpath]);
		return null;
	}
	if (subpath !== '.') return null;
	return typeof manifest?.module === 'string' ? manifest.module : (manifest?.main ?? null);
}

/**
 * A Vite plugin, `ui-web-mutation-redirect-cadre-core`, that redirects every
 * `@serfab/cadre-core` module specifier — the bare one and every published
 * subpath — to the corresponding file inside a PRISTINE, unpatched copy of
 * the package materialised at `process.env.UI_GATE_PRISTINE_CADRE_CORE`.
 *
 * WHY A RESOLVER REDIRECT AND NOT A DIST EDIT.
 * `project_esbuild_minifier_defeats_naive_dist_controls` measured that
 * esbuild RENAMES bare local bindings, so a dist-level control has to land
 * on something the minifier cannot rename — and a post-build mutation is not
 * a build-level difference at all, it is an edit to an artefact the build
 * already finished producing. A module-resolution redirect is immune to
 * renaming BY CONSTRUCTION, because it changes WHICH SOURCE THE BUILD READS
 * rather than what a built file says. This is the same move 56-06 made by
 * reusing `dist-gate/` as a genuine `publicDir: false` build, and the same
 * move 56-03 made with a build-time CSS transform.
 *
 * WHY REDIRECTING THE ENTRY POINTS IS ENOUGH, and why nobody should
 * "improve" this into a per-file rewrite: the pristine package's own
 * internal imports are RELATIVE, so once an entry point resolves inside the
 * pristine directory every module it pulls in resolves inside it too — the
 * whole subtree travels with the entry. A per-file rewrite would add surface
 * with no additional effect and would silently start depending on the
 * package's internal layout.
 *
 * FAIL-CLOSED AT PLUGIN CONSTRUCTION, not at `closeBundle`, for the same
 * reason `resolveMutation()` throws at module scope: a mutant build that ran
 * with no redirect target could quietly become a second, healthy shipping
 * path. An unset or non-existent `UI_GATE_PRISTINE_CADRE_CORE`, a manifest
 * that is not this package, or a published subpath whose file is missing are
 * all refusals, never warnings.
 *
 * STANDING RULE, restated here on the identical precedent the plugins above
 * state it: this runs against SOURCE, before a real `vite build`. It never
 * edits a built `dist/`, and it never injects anything into a page at
 * runtime.
 *
 * `closeBundle` throws `MUTATION IS A NO-OP` on zero redirects — a bundle
 * whose closure never touched the package at all is a DIFFERENT verdict from
 * a bundle built against pristine bytes, and reporting the two as the same
 * thing is exactly the escape hatch this control exists to deny itself.
 *
 * @returns {import('vite').Plugin}
 */
export function redirectCadreCorePlugin() {
	const pristineDir = process.env.UI_GATE_PRISTINE_CADRE_CORE;
	if (!pristineDir) {
		throw new Error(
			'UI_GATE_PRISTINE_CADRE_CORE must name the directory holding a pristine, unpatched ' +
				`${CADRE_CORE_SPECIFIER} package root — it is unset or empty. A mutant build that ran with no ` +
				'redirect target could quietly become a second, healthy shipping path; this throw is what stops that.',
		);
	}
	const pristineRoot = path.resolve(pristineDir);
	const manifestPath = path.join(pristineRoot, 'package.json');
	if (!existsSync(manifestPath)) {
		throw new Error(
			`UI_GATE_PRISTINE_CADRE_CORE="${pristineDir}" has no package.json at "${manifestPath}" — refusing to build ` +
				'rather than emitting a bundle that silently resolved the patched workspace copy after all.',
		);
	}
	/** @type {Record<string, any>} */
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (manifest.name !== CADRE_CORE_SPECIFIER) {
		throw new Error(
			`UI_GATE_PRISTINE_CADRE_CORE="${pristineDir}" holds package "${manifest.name}", not "${CADRE_CORE_SPECIFIER}".`,
		);
	}

	let redirects = 0;
	/** @type {Set<string>} */
	const redirected = new Set();
	/** @type {string | null} */
	let outDirAbs = null;

	return {
		name: 'ui-web-mutation-redirect-cadre-core',
		// `enforce: 'pre'`, on the identical precedent the two plugins above
		// carry it: a `resolveId` hook must see the specifier BEFORE Vite's own
		// dependency pre-bundling and alias resolution have already turned it
		// into an optimized-dep path, or the redirect counts zero on a build
		// that still exits 0 — a genuine no-op, caught by `closeBundle` below,
		// but one that costs a whole run to discover.
		enforce: 'pre',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		resolveId(source) {
			if (source !== CADRE_CORE_SPECIFIER && !source.startsWith(`${CADRE_CORE_SPECIFIER}/`)) return null;
			const subpath = source === CADRE_CORE_SPECIFIER ? '.' : `.${source.slice(CADRE_CORE_SPECIFIER.length)}`;
			const relative = resolveManifestSubpath(manifest, subpath);
			if (!relative) {
				throw new Error(
					`ui-web-mutation-redirect-cadre-core: the pristine copy at "${pristineRoot}" publishes no "${subpath}" ` +
						'subpath, so this build cannot be redirected wholesale. Refusing rather than resolving half the ' +
						'closure to pristine bytes and half to the patched workspace copy.',
				);
			}
			const target = path.resolve(pristineRoot, relative);
			if (!existsSync(target)) {
				throw new Error(
					`ui-web-mutation-redirect-cadre-core: the pristine copy publishes "${subpath}" as "${relative}", but ` +
						`"${target}" does not exist.`,
				);
			}
			redirects += 1;
			redirected.add(subpath);
			return target;
		},
		closeBundle() {
			if (redirects === 0) {
				throw new Error(
					`MUTATION IS A NO-OP: redirectCadreCorePlugin redirected zero "${CADRE_CORE_SPECIFIER}" specifiers, so this ` +
						'build read the same bytes the healthy build reads and the cadre-patch-reverted mutation did not fire. ' +
						'A verdict computed from this bundle would describe the healthy build, not the reverted one.',
				);
			}
			if (!outDirAbs) {
				throw new Error('redirectCadreCorePlugin: outDir was never resolved (configResolved did not run)');
			}
			// `closeBundle` also runs on rollup's ERROR path, where no output
			// has been written and `outDir` may not exist. Creating it here
			// keeps a missing directory from masking the build's REAL error
			// with an ENOENT from this line (measured live).
			mkdirSync(outDirAbs, { recursive: true });
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify(
					{
						mutation: 'cadre-patch-reverted',
						removals: redirects,
						redirected: [...redirected],
						pristineDir: pristineRoot,
					},
					null,
					2,
				),
			);
		},
	};
}

/**
 * The forward-slash-normalised path suffix identifying the ONE module
 * `stripPeerNotifyPlugin` acts on, and the name of the one call it removes.
 * Both are module constants rather than inline literals, on the precedent
 * `GAP_MODIFIER_CLASS` states for itself.
 */
const PEER_NOTIFY_MODULE_SUFFIX = 'src/peer/reactivity-bridge.js';
const PEER_NOTIFY_CALLEE = 'notifyPeerWrite';

/**
 * A Vite plugin, `ui-web-mutation-strip-peer-notify`, that removes the ONE
 * complete single-line statement invoking the peer-notify function from the
 * public app's replication bridge — the statement 56-09 deliberately pinned
 * to one statement on one line, with no other work on that line, and
 * deliberately NOT behind a flag, an option or an injected collaborator.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It removes the liveness
 * ANNOUNCEMENT and nothing else: the replicated rows are still applied, the
 * store still holds them, and a reader that re-queries still sees them. What
 * disappears is the data event that tells the UI a peer write landed. That is
 * why the control which drives this mutation requires EVERY non-liveness rung
 * to stay green — a build where everything goes red proves the build broke,
 * not that this statement carries liveness.
 *
 * A DIFFERENT, STRONGER CLAIM THAN 56-09's OWN TASK 3. 56-09 already proved
 * this statement removable by a source transform at the Node tier, against
 * fakes and without a bundle. That is a weaker sibling claim, and it is NOT
 * retired by this plugin: it measures the module's behaviour in isolation,
 * whereas this plugin measures a real browser bundle built from mutated
 * source. Both stand; neither is a duplicate of the other.
 *
 * WHY IT THROWS ON MORE THAN ONE MATCH as well as on zero. An ambiguous
 * target means the mutation is not the isolated one it claims to be, and a
 * two-statement removal reported as a one-statement inversion would be worse
 * than not running the control at all.
 *
 * STANDING RULE, restated: this runs against SOURCE, before a real
 * `vite build`. It never edits a built `dist/`, and it never injects anything
 * into a page at runtime.
 *
 * @returns {import('vite').Plugin}
 */
export function stripPeerNotifyPlugin() {
	let removals = 0;
	/** @type {string[]} */
	const removedStatements = [];
	/** @type {string | null} */
	let outDirAbs = null;

	// One complete statement on one line: optional leading indentation, an
	// optional `await`, the callee, a parenthesised argument list carrying no
	// `;` and no newline, an optional trailing semicolon, and the line break.
	const statementRe = new RegExp(
		`^[ \\t]*(?:await[ \\t]+)?${escapeRegExp(PEER_NOTIFY_CALLEE)}[ \\t]*\\([^;\\n]*\\)[ \\t]*;?[ \\t]*\\r?\\n`,
		'gm',
	);

	return {
		name: 'ui-web-mutation-strip-peer-notify',
		// `enforce: 'pre'` for the same MEASURED reason `stripTokensPlugin`
		// carries it: a normal-priority plugin can be handed source another
		// transform already rewrote, and this mutation matches a whole SOURCE
		// LINE. Running `pre` intercepts the raw, unrewritten module text.
		enforce: 'pre',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		transform(code, id) {
			const bareId = id.split('?')[0].split(path.sep).join('/');
			if (!bareId.endsWith(PEER_NOTIFY_MODULE_SUFFIX)) return null;
			statementRe.lastIndex = 0;
			const matches = code.match(statementRe);
			if (!matches || matches.length === 0) return null;
			removals += matches.length;
			for (const m of matches) removedStatements.push(m.trim());
			return { code: code.replace(statementRe, ''), map: null };
		},
		closeBundle() {
			if (removals === 0) {
				throw new Error(
					`MUTATION IS A NO-OP: stripPeerNotifyPlugin found no single-line ${PEER_NOTIFY_CALLEE}(...) statement in a ` +
						`module whose path ends with "${PEER_NOTIFY_MODULE_SUFFIX}", so the notify-disabled mutation did not fire. ` +
						'A control run against an unmutated build would falsely report the liveness seam inert, which is a ' +
						'different verdict entirely.',
				);
			}
			if (removals > 1) {
				throw new Error(
					`MUTATION IS AMBIGUOUS: stripPeerNotifyPlugin removed ${removals} statements, not 1 — the target is no longer ` +
						'the isolated one-statement call site 56-09 pinned, so this mutation cannot claim to invert exactly the ' +
						`liveness announcement. Removed: ${JSON.stringify(removedStatements)}`,
				);
			}
			if (!outDirAbs) {
				throw new Error('stripPeerNotifyPlugin: outDir was never resolved (configResolved did not run)');
			}
			// Same reason `redirectCadreCorePlugin` does it: `closeBundle`
			// also runs on rollup's error path, and an ENOENT from this line
			// would mask the build's real error.
			mkdirSync(outDirAbs, { recursive: true });
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify({ mutation: 'notify-disabled', removals: 1, removedStatement: removedStatements[0] }, null, 2),
			);
		},
	};
}

/**
 * Reads and parses `<outDir>/.mutation-report.json`, throwing a distinct
 * message when the file is absent — a control can never treat a missing
 * report as a passing mutation.
 *
 * @param {string} outDirAbs
 * @returns {Record<string, any>}
 */
export function readMutationReport(outDirAbs) {
	const reportPath = path.join(outDirAbs, '.mutation-report.json');
	if (!existsSync(reportPath)) {
		throw new Error(
			`MUTATION REPORT MISSING at "${reportPath}" — a control can never treat a missing report as a passing mutation.`,
		);
	}
	return JSON.parse(readFileSync(reportPath, 'utf8'));
}
