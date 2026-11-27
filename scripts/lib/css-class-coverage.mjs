#!/usr/bin/env node
//
// scripts/lib/css-class-coverage.mjs
//
// Purpose : the tier-1, dependency-free half of CR-01's gap closure (Phase 53).
//           `packages/ui-web/scripts/run-ui-gates.mjs`'s new
//           `resolved-component-styles` browser rung proves a shared
//           component's class name resolves to a real rule at runtime, in a
//           real browser, against one already-built page. This module proves
//           the CHEAPER, more total version of the same fact WITHOUT a
//           browser: every class name a consumer's own `src/` renders, plus
//           every class name rendered by any `@votetorrent/ui-web/components`
//           export that consumer actually mounts, has a matching selector
//           somewhere in that consumer's own reachable CSS. This is the check
//           that would have caught CR-01's five missing selectors before any
//           browser ever ran.
//
//           Scope, deliberately narrow: "reachable CSS" here means every
//           `.css` file physically located under the consumer's own `src/`
//           directory, plus any `@votetorrent/ui-web/*.css` stylesheet an
//           `@import` inside one of those files names (resolved through this
//           package's own `package.json` `exports` map — never a hard-coded
//           path). It does NOT trace which `.tsx` module actually imports
//           which `.css` file at the JS level — CR-01's own root cause
//           (`.pv-disclosure`/`.lifecycle-pill` living only in the
//           DASHBOARD's own css files) is caught precisely because those
//           files are not under the PUBLIC app's `src/` at all, which is the
//           property this check needs.
//
// Modes   : imported as an ESM module by each consumer's own tier-1 test
//           (`test/node/css-class-coverage.test.mjs`). Not a CLI.
//
// Deps    : node:fs, node:path, node:url only.
//
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from './strip-comments.mjs';

/**
 * Strips `/* ... *\/` block comments from a CSS source, mirroring
 * `packages/ui-web/scripts/lib/tokens.mjs`'s own `stripBlockComments`
 * discipline — a selector-shaped string inside a comment must never be
 * mistaken for a declared rule.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripCssComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Comment stripper for JS/TSX source, reading through
 * `scripts/lib/strip-comments.mjs`'s shared, character-level,
 * quote-state-tracking `stripComments` (54-23) rather than a local
 * line-opening filter — a match must not be satisfiable by prose in a
 * header comment (this file's own header names `className=` and `@import`
 * in prose above for exactly that reason: every matcher below strips
 * comments FIRST, so neither occurrence above can ever satisfy it). Kept
 * under this name for its two existing call sites below; no external
 * consumer imports this name directly (grepped at 54-23 time).
 *
 * @param {string} source
 * @returns {string}
 */
export function stripJsCommentLines(source) {
	return stripComments(source);
}

/**
 * Recursively walks `dir`, returning every file path (absolute) whose name
 * ends with one of `extensions`.
 *
 * @param {string} dir
 * @param {ReadonlyArray<string>} extensions
 * @returns {string[]}
 */
export function walkFilesWithExtensions(dir, extensions) {
	/** @type {string[]} */
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFilesWithExtensions(full, extensions));
		} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Extracts every whitespace-delimited class-name token from every STATIC
 * `className="..."` attribute in `source` (comment-stripped source expected).
 * Deliberately does not attempt to parse a template-literal `className={\`...\`}`
 * form with interpolation — no app-level `src/` file in this repo uses that
 * form today (only the package's own `LifecyclePill` does, and its class
 * names are covered by the manifest in `component-class-names.js`, not by
 * this function).
 *
 * @param {string} strippedSource
 * @returns {Set<string>}
 */
export function extractStaticClassNameTokens(strippedSource) {
	/** @type {Set<string>} */
	const tokens = new Set();
	const re = /className=["']([^"'{}]+)["']/g;
	let match;
	while ((match = re.exec(strippedSource)) !== null) {
		for (const token of match[1].split(/\s+/).filter(Boolean)) {
			tokens.add(token);
		}
	}
	return tokens;
}

/**
 * Extracts every class SELECTOR token (the identifier after a `.`) declared
 * anywhere in `strippedCss` (comment-stripped CSS source expected). Matches
 * the same permissive shape `preview-control.test.mjs`'s own
 * `every class selector in preview-as.css starts with pv-` rung already
 * uses — a compound selector like `.eo-count-grid > div` or a pseudo-class
 * chain like `.eo-row:last-child` still yields the base class token.
 *
 * @param {string} strippedCss
 * @returns {Set<string>}
 */
export function extractDeclaredSelectorTokens(strippedCss) {
	/** @type {Set<string>} */
	const tokens = new Set();
	const re = /\.([A-Za-z][\w-]*)/g;
	let match;
	while ((match = re.exec(strippedCss)) !== null) {
		tokens.add(match[1]);
	}
	return tokens;
}

/**
 * Resolves a `@votetorrent/ui-web/*.css` `@import` specifier to an absolute
 * file path, via that package's own `package.json` `exports` map — never a
 * hard-coded `packages/ui-web/src/...` path, so a future export rename is
 * still resolved correctly here.
 *
 * @param {string} uiWebRootDir absolute path to `packages/ui-web`
 * @param {string} specifier e.g. `@votetorrent/ui-web/components.css`
 * @returns {string | null} absolute path, or null if not a `@votetorrent/ui-web/*.css` specifier
 */
export function resolveUiWebCssImport(uiWebRootDir, specifier) {
	const prefix = '@votetorrent/ui-web/';
	if (!specifier.startsWith(prefix) || !specifier.endsWith('.css')) return null;
	const subpath = './' + specifier.slice(prefix.length);
	const pkg = JSON.parse(readFileSync(path.join(uiWebRootDir, 'package.json'), 'utf8'));
	const target = pkg.exports?.[subpath];
	if (!target) return null;
	return path.join(uiWebRootDir, target);
}

/**
 * Collects the full set of CSS files reachable from `appSrcDir`: every `.css`
 * file physically under it, plus every `@votetorrent/ui-web/*.css` stylesheet
 * an `@import` inside one of those files names (resolved via `exports`,
 * see `resolveUiWebCssImport`).
 *
 * @param {string} appSrcDir
 * @param {string} uiWebRootDir
 * @returns {string[]} absolute file paths
 */
export function collectReachableCssFiles(appSrcDir, uiWebRootDir) {
	const localCssFiles = walkFilesWithExtensions(appSrcDir, ['.css']);
	/** @type {Set<string>} */
	const packageCssFiles = new Set();
	const importRe = /@import\s+['"]([^'"]+)['"]/g;
	for (const cssFile of localCssFiles) {
		const source = readFileSync(cssFile, 'utf8');
		let match;
		while ((match = importRe.exec(source)) !== null) {
			const resolved = resolveUiWebCssImport(uiWebRootDir, match[1]);
			if (resolved) packageCssFiles.add(resolved);
		}
	}
	return [...localCssFiles, ...packageCssFiles];
}

/**
 * Given the `@votetorrent/ui-web/components` named imports actually used
 * somewhere under `appSrcDir` (comment-stripped source, matched against
 * `Object.keys(componentClassNames)`), returns the union of class names those
 * mounted components render.
 *
 * @param {string} appSrcDir
 * @param {Readonly<Record<string, ReadonlyArray<string>>>} componentClassNames
 * @returns {Set<string>}
 */
export function collectMountedPackageComponentClasses(appSrcDir, componentClassNames) {
	/** @type {Set<string>} */
	const mountedClasses = new Set();
	const sourceFiles = walkFilesWithExtensions(appSrcDir, ['.tsx', '.ts', '.jsx', '.js']);
	const combinedSource = sourceFiles.map((f) => stripJsCommentLines(readFileSync(f, 'utf8'))).join('\n');
	for (const [exportName, classNames] of Object.entries(componentClassNames)) {
		const usageRe = new RegExp(`\\b${exportName}\\b`);
		if (usageRe.test(combinedSource)) {
			for (const cls of classNames) mountedClasses.add(cls);
		}
	}
	return mountedClasses;
}

/**
 * The whole check (CR-01): every class name the app's own `src/` renders,
 * plus every class name a mounted `@votetorrent/ui-web/components` export
 * renders, must resolve to a real selector somewhere in the app's own
 * reachable CSS.
 *
 * `ignoreClassNames` is NOT a general escape hatch — it exists so a
 * consumer's own test can name a small, explicit, commented set of
 * PRE-EXISTING unstyled class names this check finds but which this task did
 * not introduce and is out of scope to fix here (see the SCOPE BOUNDARY rule:
 * only auto-fix issues directly caused by the current task's changes). Every
 * name passed here must still show up in `missing` were it omitted — this
 * function does not silently drop a name that was never actually missing, so
 * a stale ignore entry (one a later commit already fixed) is easy to notice:
 * remove it and the entry that no longer does anything.
 *
 * @param {{ appSrcDir: string, uiWebRootDir: string, componentClassNames: Readonly<Record<string, ReadonlyArray<string>>>, ignoreClassNames?: ReadonlyArray<string> }} opts
 * @returns {{ missing: string[], renderedCount: number, declaredCount: number }}
 */
export function checkClassNameCoverage({ appSrcDir, uiWebRootDir, componentClassNames, ignoreClassNames = [] }) {
	const sourceFiles = walkFilesWithExtensions(appSrcDir, ['.tsx', '.ts', '.jsx', '.js']);
	/** @type {Set<string>} */
	const rendered = new Set();
	for (const file of sourceFiles) {
		const stripped = stripJsCommentLines(readFileSync(file, 'utf8'));
		for (const token of extractStaticClassNameTokens(stripped)) rendered.add(token);
	}
	for (const token of collectMountedPackageComponentClasses(appSrcDir, componentClassNames)) {
		rendered.add(token);
	}

	const cssFiles = collectReachableCssFiles(appSrcDir, uiWebRootDir);
	/** @type {Set<string>} */
	const declared = new Set();
	for (const file of cssFiles) {
		const stripped = stripCssComments(readFileSync(file, 'utf8'));
		for (const token of extractDeclaredSelectorTokens(stripped)) declared.add(token);
	}

	const ignoreSet = new Set(ignoreClassNames);
	const missing = [...rendered].filter((cls) => !declared.has(cls) && !ignoreSet.has(cls)).sort();
	return { missing, renderedCount: rendered.size, declaredCount: declared.size };
}
