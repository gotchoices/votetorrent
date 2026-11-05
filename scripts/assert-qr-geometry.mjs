#!/usr/bin/env node
// QR screenshot geometry gate (phase 64, D-03). Measures a device screenshot of the full-screen QR.
//
// Usage:
//   node scripts/assert-qr-geometry.mjs <screenshot.png> --n <N> --theme light|dark \
//        [--expect-sha256-prefix <hex>]
//   node scripts/assert-qr-geometry.mjs --selftest
//
// Exit codes: 0 PASS, 1 FAIL, 2 usage error or unreadable input.
//
// --n and --theme are REQUIRED with no default. A silent default would measure the wrong code.
// The QR surface is white in both themes (it never follows the theme), so the same checks apply to
// both; the flag only makes the evidence record which theme a screenshot came from.
//
// What it measures, from the pixels: the module count the decoder reports against --n; the QR
// square's edges, walked outward from the three finder-pattern centres; the whole-pixel module size
// (the square side divided by n, which must also equal the finder ring thickness); that every module
// block is uniform; that the QR square holds only pure black and pure white; the run of pure white
// beyond each side (at least four modules, capped at eight); that the module size is the largest
// that fits the screen width; and that the panel is centred within one pixel.
//
// The join code is a bearer credential (D-06): this tool prints a 12-hex digest prefix of the
// decoded text and never the text. The selftest renders in memory and writes no file. In the
// selftest, each planted defect must fail with its own named reason, and each healthy case must
// reproduce the synthetic ground truth, so the measurements themselves are proven, not only verdicts.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadDeps() {
	try {
		const req = createRequire(new URL("../apps/VoteTorrentAuthority/package.json", import.meta.url));
		const jsqrMod = req("jsqr");
		return {
			PNG: req("pngjs").PNG,
			jsQR: jsqrMod.default ?? jsqrMod,
			qrcode: req("qrcode-generator"),
		};
	} catch {
		console.log("USAGE-ERROR: cannot resolve pngjs, jsqr and qrcode-generator from the Authority app");
		process.exit(2);
	}
}

const sha12 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

function isDarkPx(rgba, w, x, y) {
	const i = (y * w + x) * 4;
	return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 < 128;
}
function isPure(rgba, w, x, y, v) {
	const i = (y * w + x) * 4;
	return rgba[i] === v && rgba[i + 1] === v && rgba[i + 2] === v && rgba[i + 3] === 255;
}

/** Walk from a finder centre: dark core, light ring, dark ring, then the first light pixel. */
function walkEdge(rgba, w, h, cx, cy, dx, dy) {
	let x = cx;
	let y = cy;
	if (x < 0 || y < 0 || x >= w || y >= h || !isDarkPx(rgba, w, x, y)) return null;
	let phase = 0;
	let ring = 0;
	for (;;) {
		const nx = x + dx;
		const ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= w || ny >= h) return phase === 2 ? { x, y, ring } : null;
		const prevX = x;
		const prevY = y;
		x = nx;
		y = ny;
		const d = isDarkPx(rgba, w, x, y);
		if (phase === 0) {
			if (!d) phase = 1;
		} else if (phase === 1) {
			if (d) {
				phase = 2;
				ring = 1;
			}
		} else if (d) {
			ring++;
		} else {
			return { x: prevX, y: prevY, ring };
		}
	}
}

export function measureQrGeometry(jsQR, rgba, width, height, { n, theme, expectSha256Prefix } = {}) {
	const out = {
		pass: false,
		reasons: [],
		n,
		theme,
		m: 0,
		side: 0,
		quiet: [0, 0, 0, 0],
		panel: 0,
		width,
		nonPure: 0,
		decoded: false,
		version: 0,
		sha256Prefix: "-",
	};
	const fail = (r) => {
		if (!out.reasons.includes(r)) out.reasons.push(r);
	};

	const found = jsQR(new Uint8ClampedArray(rgba), width, height, {
		inversionAttempts: "dontInvert",
	});
	if (!found) {
		fail("no-qr");
		return out;
	}
	out.decoded = true;
	out.version = found.version;
	out.sha256Prefix = sha12(found.data);
	if (17 + 4 * found.version !== n) fail("n-mismatch");
	if (expectSha256Prefix && !out.sha256Prefix.startsWith(String(expectSha256Prefix).toLowerCase())) {
		fail("content-mismatch");
	}

	const loc = found.location;
	const rnd = (p) => [Math.round(p.x), Math.round(p.y)];
	const [tlx, tly] = rnd(loc.topLeftFinderPattern);
	const [trx, try_] = rnd(loc.topRightFinderPattern);
	const [blx, bly] = rnd(loc.bottomLeftFinderPattern);
	const left = walkEdge(rgba, width, height, tlx, tly, -1, 0);
	const top = walkEdge(rgba, width, height, tlx, tly, 0, -1);
	const right = walkEdge(rgba, width, height, trx, try_, 1, 0);
	const bottom = walkEdge(rgba, width, height, blx, bly, 0, 1);
	if (!left || !top || !right || !bottom) {
		fail("grid-misaligned");
		return out;
	}
	const L = left.x;
	const T = top.y;
	const R = right.x;
	const B = bottom.y;
	const sideX = R - L + 1;
	const sideY = B - T + 1;
	out.side = sideX;

	if (sideX < 1 || sideY < 1) {
		fail("fractional-module");
		return out;
	}
	if (sideX !== sideY || sideX % n !== 0 || left.ring !== sideX / n) fail("fractional-module");
	const m = sideX / n;
	out.m = m;
	out.panel = (n + 8) * Math.floor(m);

	// purity inside the QR square
	let nonPure = 0;
	for (let y = T; y <= B; y++) {
		for (let x = L; x <= R; x++) {
			if (!isPure(rgba, width, x, y, 0) && !isPure(rgba, width, x, y, 255)) nonPure++;
		}
	}
	out.nonPure = nonPure;
	if (nonPure > 0) fail("non-pure-pixels");

	// grid: every m x m module block is uniform
	if (Number.isInteger(m) && m >= 1) {
		let bad = 0;
		for (let r = 0; r < n && bad === 0; r++) {
			for (let c = 0; c < n; c++) {
				const x0 = L + c * m;
				const y0 = T + r * m;
				const first = isDarkPx(rgba, width, x0, y0);
				let uniform = true;
				for (let dy = 0; dy < m && uniform; dy++) {
					for (let dx = 0; dx < m; dx++) {
						if (isDarkPx(rgba, width, x0 + dx, y0 + dy) !== first) {
							uniform = false;
							break;
						}
					}
				}
				if (!uniform) {
					bad++;
					break;
				}
			}
		}
		if (bad > 0) fail("grid-misaligned");
	}

	// quiet zone: the run of pure white beyond each side, over the full QR extent, capped at 8m
	const cap = Math.max(1, Math.floor(8 * m));
	const run = (fromX, fromY, dx, dy, lineDx, lineDy, count) => {
		let min = cap;
		for (let k = 0; k < count; k++) {
			let r = 0;
			let x = fromX + k * lineDx;
			let y = fromY + k * lineDy;
			while (r < cap && x >= 0 && y >= 0 && x < width && y < height && isPure(rgba, width, x, y, 255)) {
				r++;
				x += dx;
				y += dy;
			}
			if (r < min) min = r;
			if (min === 0) break;
		}
		return min;
	};
	out.quiet = [
		run(L - 1, T, -1, 0, 0, 1, sideY),
		run(L, T - 1, 0, -1, 1, 0, sideX),
		run(R + 1, T, 1, 0, 0, 1, sideY),
		run(L, B + 1, 0, 1, 1, 0, sideX),
	];
	if (out.quiet.some((q) => q < 4 * m)) fail("quiet-zone");

	if (m !== Math.floor(width / (n + 8))) fail("not-largest-fit");

	const marginL = L - 4 * m;
	const marginR = width - 1 - R - 4 * m;
	if (Math.abs(marginL - marginR) > 1) fail("not-centered");

	out.pass = out.reasons.length === 0;
	return out;
}

function line(r) {
	const verdict = r.pass ? "PASS" : "FAIL " + r.reasons.join(",");
	return (
		`QR theme=${r.theme} n=${r.n} m=${r.m} side=${r.side} quiet=${r.quiet.join("/")} panel=${r.panel} ` +
		`width=${r.width} nonPure=${r.nonPure} decode=${r.decoded ? "ok" : "none"} version=${r.version} ` +
		`sha256=${r.sha256Prefix} : ${verdict}`
	);
}

// ---------------------------------------------------------------------------------------------
// selftest: in-memory screenshots

function qrModules(qrcode, text) {
	const qr = qrcode(0, "L");
	qr.addData(text, "Byte");
	qr.make();
	const n = qr.getModuleCount();
	const dark = new Uint8Array(n * n);
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark[r * n + c] = qr.isDark(r, c) ? 1 : 0;
	return { n, dark };
}

const W = 1080;
const H = 2400;

function blank(fill = 255) {
	const rgba = new Uint8Array(W * H * 4);
	rgba.fill(fill);
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	return rgba;
}
function fillRect(rgba, x, y, w, h, v) {
	for (let yy = y; yy < y + h; yy++) {
		for (let xx = x; xx < x + w; xx++) {
			const i = (yy * W + xx) * 4;
			rgba[i] = v;
			rgba[i + 1] = v;
			rgba[i + 2] = v;
			rgba[i + 3] = 255;
		}
	}
}

/** Render a QR at `scale` pixels per module (may be fractional) with its square at (qrX, qrY). */
function render({ mods, scale, qrX, qrY, dark = 0, bars = false }) {
	const rgba = blank(255);
	if (bars) {
		fillRect(rgba, 0, 0, W, 84, 0x12);
		fillRect(rgba, 0, 2316, W, 84, 0x12);
	}
	const { n, dark: d } = mods;
	const edge = (k) => Math.round(k * scale);
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (!d[r * n + c]) continue;
			const x0 = qrX + edge(c);
			const y0 = qrY + edge(r);
			fillRect(rgba, x0, y0, qrX + edge(c + 1) - x0, qrY + edge(r + 1) - y0, dark);
		}
	}
	return rgba;
}

function healthyScene(mods, { bars = false, shift = 0, mOverride } = {}) {
	const n = mods.n;
	const m = mOverride ?? Math.floor(W / (n + 8));
	const panelX = Math.floor((W - (n + 8) * m) / 2) + shift;
	const panelY = 300;
	const qrX = panelX + 4 * m;
	const qrY = panelY + 4 * m;
	const rgba = render({ mods, scale: m, qrX, qrY, bars });
	fillRect(rgba, 220, panelY + (n + 8) * m + 63, 640, 42, 0);
	const side = n * m;
	const truth = {
		m,
		side,
		quiet: [
			Math.min(8 * m, qrX),
			Math.min(8 * m, qrY),
			Math.min(8 * m, W - (qrX + side)),
			Math.min(8 * m, H - (qrY + side)),
		],
	};
	return { rgba, truth, qrX, qrY, side };
}

function runSelftest({ PNG, jsQR, qrcode }) {
	let source;
	try {
		source = readFileSync(join(HERE, "..", "packages", "vote-engine", "test", "fixtures", "join-code-fixtures.generated.ts"), "utf8");
	} catch {
		source = "";
	}
	const texts = [];
	for (const m of source.matchAll(/"(vtjoin2\.[^"\\]*)"/g)) texts.push(JSON.parse(`"${m[1]}"`));
	if (texts.length < 2) {
		console.log("SELFTEST: real-encoder fixtures not found");
		return 2;
	}
	texts.sort((a, b) => a.length - b.length);
	const smallText = texts[0];
	const largeText = texts[texts.length - 1];
	const small = qrModules(qrcode, smallText);
	const large = qrModules(qrcode, largeText);
	console.log(`SELFTEST fixtures: small chars=${smallText.length} n=${small.n}, large chars=${largeText.length} n=${large.n}`);

	const results = [];
	const cases = [];
	const healthy = (name, mods, text, extra = {}) => {
		const s = healthyScene(mods, extra);
		cases.push({ name, expect: "PASS", rgba: s.rgba, n: mods.n, text, truth: s.truth, viaPng: extra.viaPng });
	};
	const failing = (name, token, rgba, n, extra = {}) => {
		cases.push({ name, expect: token, rgba, n, ...extra });
	};

	healthy("healthy-small-light", small, smallText, { viaPng: true });
	healthy("healthy-large-light", large, largeText);
	healthy("healthy-dark-chrome", small, smallText, { bars: true });

	{
		const s = healthyScene(small);
		failing("wrong-n", "n-mismatch", s.rgba, small.n + 4);
	}
	{
		const m = Math.floor(W / (small.n + 8));
		const scale = m - 0.5;
		const side = Math.round(small.n * scale);
		const qrX = Math.floor((W - side) / 2);
		failing("half-pixel-scale", "fractional-module", render({ mods: small, scale, qrX, qrY: 400 }), small.n);
	}
	{
		const s = healthyScene(small);
		const m = s.truth.m;
		for (let y = s.qrY; y < s.qrY + s.side; y++) fillRect(s.rgba, s.qrX + 5 * m, y, 1, 1, 0x80);
		failing("antialiased-edge", "non-pure-pixels", s.rgba, small.n);
	}
	{
		const m = Math.floor(W / (small.n + 8));
		const qrX = Math.floor((W - (small.n + 8) * m) / 2) + 4 * m;
		failing("tinted-modules", "non-pure-pixels", render({ mods: small, scale: m, qrX, qrY: 300 + 4 * m, dark: 0x20 }), small.n);
	}
	{
		const s = healthyScene(small);
		const m = s.truth.m;
		fillRect(s.rgba, s.qrX - 2 * m - 20, s.qrY + Math.floor(s.side / 2) - 10, 20, 20, 0);
		failing("quiet-zone-intrusion", "quiet-zone", s.rgba, small.n);
	}
	{
		const m = Math.floor(W / (small.n + 8)) - 1;
		const s = healthyScene(small, { mOverride: m });
		failing("smaller-than-fit", "not-largest-fit", s.rgba, small.n);
	}
	{
		const m = Math.floor(W / (small.n + 8));
		const s = healthyScene(small, { shift: m });
		failing("off-center", "not-centered", s.rgba, small.n);
	}
	{
		const s = healthyScene(small);
		const inv = s.rgba.slice();
		for (let i = 0; i < inv.length; i += 4) {
			inv[i] = 255 - inv[i];
			inv[i + 1] = 255 - inv[i + 1];
			inv[i + 2] = 255 - inv[i + 2];
		}
		failing("inverted", "no-qr", inv, small.n);
	}
	failing("blank", "no-qr", blank(255), small.n);
	{
		const s = healthyScene(small);
		failing("wrong-content", "content-mismatch", s.rgba, small.n, { expectSha256Prefix: sha12(largeText) });
	}

	let allOk = true;
	for (const c of cases) {
		let rgba = c.rgba;
		if (c.viaPng) {
			const png = new PNG({ width: W, height: H });
			png.data = Buffer.from(rgba);
			const back = PNG.sync.read(PNG.sync.write(png));
			rgba = back.data;
		}
		const r = measureQrGeometry(jsQR, rgba, W, H, {
			n: c.n,
			theme: "light",
			expectSha256Prefix: c.expectSha256Prefix ?? (c.text ? sha12(c.text) : undefined),
		});
		let ok;
		if (c.expect === "PASS") {
			ok =
				r.pass &&
				r.reasons.length === 0 &&
				r.m === c.truth.m &&
				r.side === c.truth.side &&
				r.quiet.join("/") === c.truth.quiet.join("/");
		} else {
			ok = !r.pass && r.reasons.includes(c.expect);
		}
		const want = c.expect === "PASS" ? "PASS" : `FAIL:${c.expect}`;
		const got = r.pass ? "PASS" : `FAIL:${r.reasons.join(",")}`;
		console.log(`SELFTEST ${c.name}: expected ${want} got ${got}${ok ? " ok" : " MISMATCH"}`);
		if (!ok) allOk = false;
		results.push(ok);
	}
	console.log(`SELFTEST: ${results.filter(Boolean).length}/${results.length} cases matched`);
	return allOk ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// CLI

function usage(msg) {
	console.log(`USAGE-ERROR: ${msg}`);
	console.log("usage: assert-qr-geometry.mjs <screenshot.png> --n <N> --theme light|dark [--expect-sha256-prefix <hex>] | --selftest");
	return 2;
}

function main(argv) {
	if (argv.length === 1 && argv[0] === "--selftest") return runSelftest(loadDeps());
	let file;
	let n;
	let theme;
	let prefix;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--n") n = Number(argv[++i]);
		else if (a === "--theme") theme = argv[++i];
		else if (a === "--expect-sha256-prefix") prefix = argv[++i];
		else if (a.startsWith("--")) return usage(`unknown flag ${a}`);
		else if (file === undefined) file = a;
		else return usage("more than one screenshot given");
	}
	if (!file) return usage("no screenshot given");
	if (!Number.isInteger(n) || n < 21 || n > 177 || (n - 17) % 4 !== 0) return usage("--n is required and must be a valid QR module count");
	if (theme !== "light" && theme !== "dark") return usage("--theme is required (light or dark)");
	if (prefix !== undefined && !/^[0-9a-fA-F]{1,64}$/.test(prefix)) return usage("--expect-sha256-prefix must be hex");
	const { PNG, jsQR } = loadDeps();
	let img;
	try {
		img = PNG.sync.read(readFileSync(file));
	} catch {
		return usage("screenshot is not a readable PNG");
	}
	const r = measureQrGeometry(jsQR, img.data, img.width, img.height, { n, theme, expectSha256Prefix: prefix });
	console.log(line(r));
	return r.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(main(process.argv.slice(2)));
}
