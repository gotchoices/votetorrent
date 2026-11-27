/**
 * public-assets-shape.test.mjs — the SOURCE/ARTEFACT contract for the D-20
 * favicon set (56-06), distinct from `test/browser/run-public-assets-gate.mjs`'s
 * rendered, network-log proof. This file never boots a browser; it reads
 * bytes off disk.
 *
 * Two anti-vacuity controls run FIRST, before either predicate this file
 * relies on is trusted against the real assets:
 *
 *   1. the IHDR reader must correctly report the dimensions of a
 *      deliberately-wrong synthetic PNG fixture (not merely happen to agree
 *      with the real assets it will later be pointed at);
 *   2. the `<link>` matcher must fail to match a `<link rel="stylesheet">`
 *      line — a matcher that fires on everything would make a green result
 *      against the real four tags meaningless.
 *
 * PNG dimensions are read straight from each file's IHDR chunk (big-endian
 * uint32 at byte offsets 16 and 20 of the file) — no decoder, no new
 * dependency. The opacity property of `apple-touch-icon.png` is asserted at
 * the GENERATOR'S SOURCE, not at the artefact, because reading a PNG's alpha
 * channel needs a decoder this app has no dependency for; this is a source
 * assertion whose limit is stated here rather than implied as an
 * artefact-level proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicRoot } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/**
 * Read a PNG's width/height straight from its IHDR chunk. The PNG signature
 * is 8 bytes; the first chunk is always IHDR (4-byte length + 4-byte type),
 * so width sits at byte offset 16 and height at byte offset 20, both
 * big-endian uint32 — no decoder needed.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
function readPngDims(buf) {
	if (buf.length < 24) throw new Error('readPngDims: buffer too short to contain an IHDR chunk');
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	return { width, height };
}

/**
 * Build a minimal-but-structurally-valid PNG buffer (signature + one IHDR
 * chunk, no other chunks — nothing downstream of IHDR is ever read by
 * `readPngDims`) carrying an arbitrary, deliberately-wrong width/height.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function fakePng(width, height) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrLen = Buffer.alloc(4);
	ihdrLen.writeUInt32BE(13, 0);
	const ihdrType = Buffer.from('IHDR', 'ascii');
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	// bit depth/color type/compression/filter/interlace — values are never
	// read by readPngDims, left zeroed.
	return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData]);
}

/**
 * Parse `<link ...>` tags out of an HTML source into attribute maps.
 * @param {string} html
 * @returns {Array<Record<string, string>>}
 */
function parseLinkTags(html) {
	/** @type {Array<Record<string, string>>} */
	const tags = [];
	const linkRe = /<link\s+([^>]+)>/g;
	let m;
	while ((m = linkRe.exec(html))) {
		/** @type {Record<string, string>} */
		const attrs = {};
		const attrRe = /([\w-]+)="([^"]*)"/g;
		let am;
		while ((am = attrRe.exec(m[1]))) {
			attrs[am[1]] = am[2];
		}
		tags.push(attrs);
	}
	return tags;
}

/**
 * The matcher this file relies on: a `<link>` tag counts as an "icon" link
 * only if its `rel` is `icon` or `apple-touch-icon`.
 * @param {Record<string, string>} attrs
 * @returns {boolean}
 */
function isIconLink(attrs) {
	return attrs.rel === 'icon' || attrs.rel === 'apple-touch-icon';
}

/**
 * Strip XML/HTML comments (`<!-- ... -->`). `favicon.svg`'s own header
 * necessarily discusses `<g>`, `translate(8,8)` and `scale(0.75)` in prose
 * (it explains the padding constraint the shape assertion below re-checks),
 * so a structural count run over the raw file is permanently wrong by one —
 * `project_self_tripping_checker_headers`. The shared `stripComments`
 * helper handles `//`/`/* *‍/` JS-style comments only, not XML comments, so
 * this file gets its own tiny stripper rather than mis-using that one.
 * @param {string} xml
 * @returns {string}
 */
function stripXmlComments(xml) {
	return xml.replace(/<!--[\s\S]*?-->/g, '');
}

// ---------------------------------------------------------------------------
// Anti-vacuity control 1 — the IHDR reader, proven against a fixture whose
// dimensions are NOT any of the four real assets, before it is trusted.
// ---------------------------------------------------------------------------
test('control: readPngDims correctly reports a deliberately-wrong synthetic PNG fixture', () => {
	const dims = readPngDims(fakePng(999, 111));
	assert.deepEqual(dims, { width: 999, height: 111 }, 'the IHDR reader must report exactly the bytes it was handed, not any real asset\'s dimensions');
});

// ---------------------------------------------------------------------------
// Anti-vacuity control 2 — the <link> icon matcher must NOT fire on a
// <link rel="stylesheet"> line, or a green result against the real four
// icon tags would mean nothing.
// ---------------------------------------------------------------------------
test('control: the <link> icon matcher does not match a <link rel="stylesheet"> line', () => {
	const [attrs] = parseLinkTags('<link rel="stylesheet" href="/src/app.css">');
	assert.ok(attrs, 'the benign fixture must still parse as a <link> tag');
	assert.equal(isIconLink(attrs), false, 'a stylesheet link must not be classified as an icon link');
});

// ---------------------------------------------------------------------------
// Artefacts — the four Surface 4 assets exist at the exact paths.
// ---------------------------------------------------------------------------
const ASSET_PATHS = Object.freeze({
	svg: publicRoot('public', 'favicon.svg'),
	png32: publicRoot('public', 'favicon-32x32.png'),
	png16: publicRoot('public', 'favicon-16x16.png'),
	appleTouch: publicRoot('public', 'apple-touch-icon.png'),
});

test('all four D-20 asset files exist at the exact Surface 4 paths', () => {
	for (const [name, p] of Object.entries(ASSET_PATHS)) {
		assert.doesNotThrow(() => readFileSync(p), `${name} must exist at ${p}`);
	}
});

// ---------------------------------------------------------------------------
// favicon.svg — shape assertions.
// ---------------------------------------------------------------------------
test('favicon.svg declares viewBox="0 0 64 64" and no root width/height', () => {
	const svg = stripXmlComments(readFileSync(ASSET_PATHS.svg, 'utf8'));
	assert.match(svg, /viewBox="0 0 64 64"/, 'must declare the fixed 64x64 viewBox');
	const rootTagMatch = svg.match(/<svg\b[^>]*>/);
	assert.ok(rootTagMatch, 'must have a root <svg> tag');
	assert.doesNotMatch(rootTagMatch[0], /\bwidth="/, 'root <svg> must carry no width attribute — it must scale to any size');
	assert.doesNotMatch(rootTagMatch[0], /\bheight="/, 'root <svg> must carry no height attribute — it must scale to any size');
});

test('favicon.svg contains no <image element (an SVG wrapping a raster is a raster)', () => {
	const svg = stripXmlComments(readFileSync(ASSET_PATHS.svg, 'utf8'));
	assert.doesNotMatch(svg, /<image[\s>]/, 'favicon.svg must not embed a raster via <image>');
});

test('favicon.svg carries exactly one top-level <g>, transform includes both translate(8,8) and scale(0.75)', () => {
	// Comment-stripped: the file's own header prose necessarily discusses
	// "<g>", "translate(8,8)" and "scale(0.75)" to explain the padding
	// constraint — a raw scan would find its own explanation and miscount
	// (project_self_tripping_checker_headers).
	const svg = stripXmlComments(readFileSync(ASSET_PATHS.svg, 'utf8'));
	// Top-level children of <svg>: this file's own structure (one <defs>,
	// one <g>, both direct children of the root) makes a full XML parse
	// unnecessary once comments are stripped.
	const gOpenings = svg.match(/<g\b[^>]*>/g) ?? [];
	assert.equal(gOpenings.length, 1, `expected exactly one <g> element, found ${gOpenings.length}`);
	const gTag = gOpenings[0];
	const transformMatch = gTag.match(/transform="([^"]*)"/);
	assert.ok(transformMatch, 'the <g> must carry a transform attribute');
	assert.match(transformMatch[1], /translate\(8,8\)/, 'transform must include translate(8,8) — the tab-bar padding constraint');
	assert.match(transformMatch[1], /scale\(0\.75\)/, 'transform must include scale(0.75) — the tab-bar padding constraint');
});

// ---------------------------------------------------------------------------
// PNGs — IHDR-derived dimensions, using the control-proven reader.
// ---------------------------------------------------------------------------
test('favicon-32x32.png is exactly 32x32 per its IHDR chunk', () => {
	const dims = readPngDims(readFileSync(ASSET_PATHS.png32));
	assert.deepEqual(dims, { width: 32, height: 32 });
});

test('favicon-16x16.png is exactly 16x16 per its IHDR chunk', () => {
	const dims = readPngDims(readFileSync(ASSET_PATHS.png16));
	assert.deepEqual(dims, { width: 16, height: 16 });
});

test('apple-touch-icon.png is exactly 180x180 per its IHDR chunk', () => {
	const dims = readPngDims(readFileSync(ASSET_PATHS.appleTouch));
	assert.deepEqual(dims, { width: 180, height: 180 });
});

// ---------------------------------------------------------------------------
// index.html — the four <link> tags, exact attribute sets, and no
// favicon.ico reference anywhere.
// ---------------------------------------------------------------------------
const INDEX_HTML = readFileSync(publicRoot('index.html'), 'utf8');

/** @type {ReadonlyArray<{ rel: string, href: string, type?: string, sizes?: string }>} */
const EXPECTED_LINKS = Object.freeze([
	{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
	{ rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
	{ rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
	{ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
]);

test('index.html declares all four Surface 4 <link> tags with exact attribute sets', () => {
	const iconLinks = parseLinkTags(INDEX_HTML).filter(isIconLink);
	assert.equal(iconLinks.length, 4, `expected exactly 4 icon <link> tags, found ${iconLinks.length}`);
	for (const expected of EXPECTED_LINKS) {
		const found = iconLinks.find((attrs) => attrs.href === expected.href);
		assert.ok(found, `no <link> tag found for href="${expected.href}"`);
		assert.deepEqual(found, expected, `attribute set for href="${expected.href}" must match Surface 4's table exactly`);
	}
});

test('index.html contains zero references to favicon.ico', () => {
	const matches = INDEX_HTML.match(/favicon\.ico/g) ?? [];
	assert.equal(matches.length, 0, 'this app ships no favicon.ico and must declare none — a <link rel="shortcut icon"> would reintroduce the 404');
});

// ---------------------------------------------------------------------------
// generate-favicons.mjs — the opacity property is asserted at the source,
// on a comment-stripped read (this file's own header discusses opacity in
// prose, so a checker that scans its own comments would be permanently
// green — project_self_tripping_checker_headers).
// ---------------------------------------------------------------------------
test('generate-favicons.mjs: the apple-touch-icon branch passes omitBackground: false (source assertion, not an artefact-level opacity proof)', () => {
	const source = readFileSync(publicRoot('scripts', 'generate-favicons.mjs'), 'utf8');
	const stripped = stripComments(source);
	const appleTouchLine = stripped.split('\n').find((line) => line.includes('apple-touch-icon.png'));
	assert.ok(appleTouchLine, 'generate-favicons.mjs must declare an apple-touch-icon.png target');
	assert.match(
		appleTouchLine,
		/omitBackground:\s*false/,
		'the apple-touch-icon.png target must pass omitBackground: false — iOS composites its own mask and renders transparency as black',
	);
});
