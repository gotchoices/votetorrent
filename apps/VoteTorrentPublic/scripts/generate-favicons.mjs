#!/usr/bin/env node
/**
 * generate-favicons.mjs — one-shot PNG derivation from the single
 * `public/favicon.svg` source (56-06, D-20).
 *
 * A one-shot TOOL, deliberately not wired into `build` or `dev` — run by
 * hand whenever `favicon.svg` changes, and its three outputs
 * (`favicon-32x32.png`, `favicon-16x16.png`, `apple-touch-icon.png`) are
 * committed like any other asset. Deriving all three from the ONE svg
 * source, rather than checking in three unexplained binaries, is what gives
 * the four D-20 assets a shared provenance.
 *
 * Playwright (already a devDependency of this app) loads `favicon.svg` in a
 * page sized to each target's pixel dimensions and screenshots the <svg>
 * element directly.
 *
 * `favicon-32x32.png` and `favicon-16x16.png` use `omitBackground: true` —
 * they stay transparent, matching the SVG primary asset.
 * `apple-touch-icon.png` uses `omitBackground: false` against an OPAQUE
 * background, because iOS composites its own rounded-corner mask onto a
 * home-screen icon and renders any transparent pixel as solid black. That
 * background colour is read from `--bg` in
 * `packages/ui-web/src/tokens.css` rather than invented as a new hex
 * literal here (the UI-SPEC's component inventory forbids new hex literals
 * in this phase).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const SVG_PATH = path.join(PUBLIC_DIR, 'favicon.svg');
const TOKENS_CSS_PATH = path.resolve(APP_ROOT, '..', '..', 'packages', 'ui-web', 'src', 'tokens.css');

/**
 * Read `--bg` directly from the shared tokens stylesheet — never invent a
 * hex literal in this file.
 * @returns {string}
 */
function readBgToken() {
	const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
	const match = css.match(/--bg:\s*(#[0-9a-fA-F]{3,8})\s*;/);
	if (!match) {
		throw new Error(`generate-favicons: could not find a "--bg" custom property in ${TOKENS_CSS_PATH}`);
	}
	return match[1];
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} svgMarkup
 * @param {number} size
 * @param {{ omitBackground: boolean, background: string }} opts
 * @returns {Promise<Buffer>}
 */
async function renderPng(browser, svgMarkup, size, opts) {
	const page = await browser.newPage({ viewport: { width: size, height: size } });
	try {
		const pageBackground = opts.omitBackground ? 'transparent' : opts.background;
		const html =
			'<!doctype html><html><head><style>' +
			`html,body{margin:0;padding:0;background:${pageBackground};}` +
			`svg{display:block;width:${size}px;height:${size}px;}` +
			`</style></head><body>${svgMarkup}</body></html>`;
		await page.setContent(html, { waitUntil: 'load' });
		return await page.locator('svg').screenshot({ omitBackground: opts.omitBackground });
	} finally {
		await page.close();
	}
}

/**
 * The three PNG targets derived from favicon.svg. Each entry is read
 * verbatim by `test/node/public-assets-shape.test.mjs`'s source assertion —
 * the `apple-touch-icon.png` entry passing `omitBackground: false` on the
 * same line as its filename is what that (comment-stripped) source
 * assertion greps for, because an artefact-level opacity proof would need a
 * PNG-alpha decoder this app has no dependency for.
 * @type {ReadonlyArray<{ file: string, size: number, omitBackground: boolean }>}
 */
const TARGETS = Object.freeze([
	{ file: 'favicon-32x32.png', size: 32, omitBackground: true },
	{ file: 'favicon-16x16.png', size: 16, omitBackground: true },
	{ file: 'apple-touch-icon.png', size: 180, omitBackground: false },
]);

async function main() {
	const svgMarkup = readFileSync(SVG_PATH, 'utf8');
	const background = readBgToken();

	const browser = await chromium.launch();
	try {
		for (const target of TARGETS) {
			const buffer = await renderPng(browser, svgMarkup, target.size, {
				omitBackground: target.omitBackground,
				background,
			});
			const outPath = path.join(PUBLIC_DIR, target.file);
			writeFileSync(outPath, buffer);
			console.log(
				`[generate-favicons] wrote ${target.file} (${target.size}x${target.size}, omitBackground=${target.omitBackground})`,
			);
		}
	} finally {
		await browser.close();
	}
}

main().catch((err) => {
	console.error('[generate-favicons] failed:', err);
	process.exit(1);
});
