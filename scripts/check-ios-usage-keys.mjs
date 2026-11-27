#!/usr/bin/env node
/**
 * check-ios-usage-keys.mjs
 *
 * Static gate for iOS purpose strings. A biometric-gated Secure Enclave key
 * consults the system privacy service, which aborts the process on the first
 * Face ID prompt when the app has no NSFaceIDUsageDescription. Jest mocks the
 * native module and Xcode builds without the key, so no other tier catches it.
 *
 * Modes:
 *   (default)         scan apps/* in this repo
 *   --plist <file>    check a single Info.plist (no localization check)
 *   --selftest        run the fixture cases under scripts/fixtures/ios-usage-keys
 *
 * Rules, per app that depends on @votetorrent/attestation-native:
 *   - Info.plist exists and carries a non-blank NSFaceIDUsageDescription as a TOP-LEVEL key
 *     (a direct child of the root dict, not inside an XML comment or a nested dict)
 *   - every key ending in UsageDescription is non-blank
 *   - when the app has any <lang>.lproj/InfoPlist.strings, en and es both exist
 *     and define every usage key non-blank
 * A scan that covers zero apps fails. Purpose strings are never printed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FIXTURES = join(HERE, 'fixtures', 'ios-usage-keys');
const DEP = '@votetorrent/attestation-native';
const FACE = 'NSFaceIDUsageDescription';

function decode(s) {
	return s
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/**
 * Map of key -> string value (undefined when the value is not a string), for the TOP-LEVEL keys
 * only: the direct children of the root <dict>, which are the only keys iOS reads for purpose
 * strings. XML comments are removed first, so a commented-out key does not count, and a key inside
 * a nested <dict> (or an <array>) is not a top-level key.
 */
export function parsePlistKeys(xml) {
	const text = xml.replace(/<!--[\s\S]*?-->/g, '');
	const out = new Map();
	// One token per element that matters for depth or for a top-level key/value pair.
	const re =
		/<key>([^<]*)<\/key>|<string>([\s\S]*?)<\/string>|<string\s*\/>|<(?:dict|array)\s*\/>|<(dict|array)>|<\/(?:dict|array)>|<(true|false)\s*\/>|<(integer|real|date|data)>[\s\S]*?<\/(?:integer|real|date|data)>/g;
	let depth = 0;
	let pendingKey = null;
	const settle = (value) => {
		if (pendingKey !== null && depth === 1) out.set(pendingKey, value);
		pendingKey = null;
	};
	let m;
	while ((m = re.exec(text)) !== null) {
		const tok = m[0];
		if (tok.startsWith('<key>')) {
			pendingKey = depth === 1 ? m[1] : null;
		} else if (tok.startsWith('<string>')) {
			settle(decode(m[2] ?? ''));
		} else if (/^<string\s*\/>$/.test(tok)) {
			settle('');
		} else if (m[3] !== undefined) {
			settle(undefined);
			depth++;
		} else if (tok.startsWith('</')) {
			pendingKey = null;
			depth--;
		} else {
			// <dict/>, <array/>, <true/>, <false/>, <integer>, <real>, <date>, <data>: not a string
			settle(undefined);
		}
	}
	return out;
}

/** Map of key -> value from an old-style .strings file; comments skipped. */
export function parseStrings(text) {
	const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const out = new Map();
	const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
	let m;
	while ((m = re.exec(stripped)) !== null) out.set(m[1], m[2]);
	return out;
}

const blank = (v) => typeof v !== 'string' || v.trim() === '';
const usageKeys = (map) => [...map.keys()].filter((k) => k.endsWith('UsageDescription'));

/** Violations for one Info.plist XML (no localization). */
export function checkPlist(xml) {
	const fails = [];
	const keys = parsePlistKeys(xml);
	if (!keys.has(FACE)) fails.push(`${FACE} is missing`);
	for (const k of usageKeys(keys)) {
		if (blank(keys.get(k))) fails.push(`${k} is empty`);
	}
	return { fails, keys };
}

function checkApp(appDir, name) {
	const plist = join(appDir, 'ios', name, 'Info.plist');
	if (!existsSync(plist)) return { name, fails: [`Info.plist not found at ios/${name}/Info.plist`], count: 0 };
	const { fails, keys } = checkPlist(readFileSync(plist, 'utf8'));
	const iosApp = join(appDir, 'ios', name);
	const lprojs = readdirSync(iosApp).filter(
		(d) => d.endsWith('.lproj') && existsSync(join(iosApp, d, 'InfoPlist.strings')),
	);
	if (lprojs.length > 0) {
		for (const lang of ['en', 'es']) {
			const f = join(iosApp, `${lang}.lproj`, 'InfoPlist.strings');
			if (!existsSync(f)) {
				fails.push(`${lang}.lproj/InfoPlist.strings is missing`);
				continue;
			}
			const strings = parseStrings(readFileSync(f, 'utf8'));
			for (const k of usageKeys(keys)) {
				if (blank(strings.get(k))) fails.push(`${lang}.lproj/InfoPlist.strings has no non-empty ${k}`);
			}
		}
	}
	return { name, fails, count: usageKeys(keys).length, localized: lprojs.length > 0 };
}

/** Scan <root>/apps/*; returns results and an overall pass flag. */
export function scanRoot(root) {
	const appsDir = join(root, 'apps');
	const results = [];
	if (existsSync(appsDir)) {
		for (const name of readdirSync(appsDir).sort()) {
			const dir = join(appsDir, name);
			const pkg = join(dir, 'package.json');
			if (!statSync(dir).isDirectory() || !existsSync(pkg)) continue;
			const j = JSON.parse(readFileSync(pkg, 'utf8'));
			if (!{ ...j.dependencies, ...j.devDependencies }[DEP]) continue;
			results.push(checkApp(dir, name));
		}
	}
	const ok = results.length > 0 && results.every((r) => r.fails.length === 0);
	return { results, ok };
}

function report({ results, ok }) {
	for (const r of results) {
		if (r.fails.length === 0) console.log(`OK ${r.name}: ${r.count} usage keys${r.localized ? ', en+es' : ''}`);
		else for (const f of r.fails) console.log(`FAIL ${r.name}: ${f}`);
	}
	if (results.length === 0) console.log('FAIL scanned zero apps that depend on ' + DEP);
	console.log(`${results.length} app(s) scanned, ${ok ? 'gate passed' : 'gate FAILED'}`);
}

const CASES = [
	['a-missing-faceid', false, FACE],
	['b-empty-faceid', false, FACE],
	['c-empty-other-key', false, 'NSCameraUsageDescription'],
	['d-es-missing-key', false, 'es.lproj'],
	['e-es-empty-value', false, 'es.lproj'],
	['f-valid', true, null],
	['g-commented-faceid', false, FACE],
	['h-nested-faceid', false, FACE],
];

function selftest() {
	let bad = 0;
	for (const [dir, shouldPass, mention] of CASES) {
		const res = scanRoot(join(FIXTURES, dir));
		const text = res.results.flatMap((r) => r.fails).join(' | ');
		const good = shouldPass ? res.ok : !res.ok && text.includes(mention);
		console.log(`${good ? 'PASS' : 'MISMATCH'} ${dir}: ${shouldPass ? 'accepted' : 'rejected'}${text ? ` (${text})` : ''}`);
		if (!good) bad++;
	}
	const empty = scanRoot(join(FIXTURES, 'no-such-dir'));
	const emptyGood = !empty.ok;
	console.log(`${emptyGood ? 'PASS' : 'MISMATCH'} z-zero-apps: rejected`);
	if (!emptyGood) bad++;
	console.log(bad === 0 ? 'selftest passed' : `selftest FAILED (${bad})`);
	return bad === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);
	const pi = args.indexOf('--plist');
	if (pi >= 0) {
		const { fails } = checkPlist(readFileSync(args[pi + 1], 'utf8'));
		for (const f of fails) console.log(`FAIL ${args[pi + 1]}: ${f}`);
		if (fails.length === 0) console.log(`OK ${args[pi + 1]}`);
		process.exit(fails.length === 0 ? 0 : 1);
	}
	const res = scanRoot(REPO);
	report(res);
	process.exit(res.ok ? 0 : 1);
}
