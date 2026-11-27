#!/usr/bin/env node
// Card button geometry gate. Measures a uiautomator dump.
//
// --density-dpi is REQUIRED (no default): read it from `adb shell wm density` on the device the
// dump came from. A silent default would measure a different device's pixels.
//
// Usage:
//   node scripts/assert-card-button-geometry.mjs <dump.xml> --density-dpi 420 \
//        --label "KEEP REVIEWING" --label "CONFIRM REJECTION"
//   node scripts/assert-card-button-geometry.mjs <dump.xml> --density-dpi 420 \
//        --label "APPROVE REGISTRATION" --label "REJECT REQUEST"   (request-detail footer)
//   node scripts/assert-card-button-geometry.mjs --selftest
//
// For each --label: find the node whose `text` equals the label, then its nearest
// clickable ancestor. PASS needs button height >= ceil(48 * dpi / 160) px AND the
// text node's bounds inside the button's bounds on all four edges.
//
// NOTE: uiautomator's `text` attribute carries the FULL string even when it is
// visually clipped, so text-equality alone never proves "not clipped". The
// containment check does. Degenerate input (missing label, zero-area bounds) FAILs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function unescapeXml(s) {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");
}

function parseAttrs(src) {
	const attrs = {};
	for (const m of src.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = unescapeXml(m[2]);
	return attrs;
}

function parseBounds(b) {
	const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(b ?? "");
	if (!m) return null;
	const [x1, y1, x2, y2] = m.slice(1).map(Number);
	return { x1, y1, x2, y2 };
}

/** Minimal tolerant tree parse: <node ...> open/close/self-close tags only. */
function parseTree(xml) {
	const root = { children: [], attrs: {}, parent: null };
	let cur = root;
	for (const m of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
		const [, closing, body, selfClose] = m;
		if (closing) {
			cur = cur.parent ?? root;
			continue;
		}
		const n = { children: [], attrs: parseAttrs(body), parent: cur };
		cur.children.push(n);
		if (!selfClose) cur = n;
	}
	return root;
}

function* walk(n) {
	for (const c of n.children) {
		yield c;
		yield* walk(c);
	}
}

// The card-button component contract is a 48 dp minimum touch target.
export const MIN_TOUCH_DP = 48;

export function measure(xml, labels, dpi) {
	const min = Math.ceil((MIN_TOUCH_DP * dpi) / 160);
	const tree = parseTree(xml);
	const nodes = [...walk(tree)];
	const results = [];
	for (const label of labels) {
		const textNode = nodes.find((n) => n.attrs.text === label);
		if (!textNode) {
			results.push({ label, pass: false, line: `LABEL ${label}: FAIL (label not found in dump)` });
			continue;
		}
		let btn = textNode;
		while (btn && btn.attrs.clickable !== "true") btn = btn.parent && btn.parent.attrs ? btn.parent : null;
		if (!btn || btn.attrs.clickable !== "true") {
			results.push({ label, pass: false, line: `LABEL ${label}: FAIL (no clickable ancestor)` });
			continue;
		}
		const tb = parseBounds(textNode.attrs.bounds);
		const bb = parseBounds(btn.attrs.bounds);
		const area = (b) => b && b.x2 > b.x1 && b.y2 > b.y1;
		if (!area(tb) || !area(bb)) {
			results.push({ label, pass: false, line: `LABEL ${label}: FAIL (degenerate bounds)` });
			continue;
		}
		const h = bb.y2 - bb.y1;
		const dp = ((h * 160) / dpi).toFixed(1);
		const inside = tb.x1 >= bb.x1 && tb.y1 >= bb.y1 && tb.x2 <= bb.x2 && tb.y2 <= bb.y2;
		const pass = h >= min && inside;
		const fmt = (b) => `[${b.x1},${b.y1}][${b.x2},${b.y2}]`;
		results.push({
			label,
			pass,
			line: `LABEL ${label}: ${pass ? "PASS" : "FAIL"} (button h=${h}px=${dp}dp min=${min}px; text ${fmt(tb)} within button ${fmt(bb)}: ${inside ? "yes" : "no"})`,
		});
	}
	return results;
}

function run(xml, labels, dpi) {
	const rs = measure(xml, labels, dpi);
	for (const r of rs) console.log(r.line);
	return rs.length > 0 && rs.every((r) => r.pass);
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "lib", "__fixtures__", "card-button-geometry");
	const labels = ["KEEP REVIEWING", "CONFIRM REJECTION"];
	let ok = true;
	for (const [f, expected, fixtureLabels] of [
		["reject-card-collapsed.xml", "FAIL"],
		["reject-card-healthy.xml", "PASS"],
		// 62-54 device reading: slot wrapper 137px (passes a slot-only check) but the
		// clickable button inside is 95px < 116px floor. The gate measures the button.
		["share-network-slot-ok-button-short.xml", "FAIL", ["DON'T SHARE", "SHARE FILE"]],
		// UAT 62 gap 4 item 2: the request-detail footer buttons measured 95px (thin, 36dp) on
		// Pixel_8; the tall size is 147px (56dp at 420dpi).
		["approval-footer-thin.xml", "FAIL", ["APPROVE REGISTRATION", "REJECT REQUEST"]],
		["approval-footer-tall.xml", "PASS", ["APPROVE REGISTRATION", "REJECT REQUEST"]],
		// A 118px button is 44.95dp at 420dpi: it cleared the old 44dp floor, fails the 48dp one.
		["button-45dp.xml", "FAIL"],
		// Tall enough (160px) but the text extends past the button's bottom edge: containment alone fails it.
		["text-outside-tall-button.xml", "FAIL"],
		// The label text is absent from the dump.
		["missing-label.xml", "FAIL"],
	]) {
		const got = run(readFileSync(join(dir, f), "utf8"), fixtureLabels ?? labels, 420) ? "PASS" : "FAIL";
		console.log(`SELFTEST ${f}: expected ${expected} got ${got}`);
		if (got !== expected) ok = false;
	}
	process.exit(ok ? 0 : 1);
}
const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--density-dpi" && argv[i - 1] !== "--label");
const labels = [];
let dpi = Number.NaN;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--label") labels.push(argv[++i]);
	else if (argv[i] === "--density-dpi") dpi = Number(argv[++i]);
}
if (!file || labels.length === 0 || !(dpi > 0)) {
	console.error("usage: assert-card-button-geometry.mjs <dump.xml> --density-dpi N --label TEXT [--label TEXT...] | --selftest");
	process.exit(2);
}
process.exit(run(readFileSync(file, "utf8"), labels, dpi) ? 0 : 1);
