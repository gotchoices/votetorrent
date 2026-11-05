/**
 * rig-probes.gate.test.ts - T-64-20 (Phase 64 plan 20): the Authority rig probes must stay read-only,
 * dev-only and out of every app bundle. The probes live outside the app, in scripts/proof, and are read here as
 * text on comment-stripped source. They are never imported: importing one would pull scripts/proof into the app
 * tsconfig.
 *
 *   A1   SQL: every eval argument is one single-quoted select literal with no write verb.
 *   A2   deny-list: no storage, vault, release, seeding, provisioning or write call.
 *   A3   allow-lists: the capture probe's member calls are pinned; the KAT probe touches no engine, hook or RN.
 *   A4   the capture probe names only the association engine.
 *   A5   every console call takes one string literal and nothing else.
 *   A6   closed result shape: pinned key lists, every assignment of the result goes through closedJson.
 *   A7   raw channel: the raw rows are confined to the capture probe's own few lines.
 *   A8   registry: one registration per name across every file in scripts/proof, __DEV__ guards.
 *   A9   Hermes: no closure inside any loop body.
 *   A10  the committed DKG vector: shape, pinned vectorId, reserved election id, check names, no join material.
 *   A11  the KAT probe imports exactly the engine dist dkg module and nothing else.
 *   A12  the host reader: no child process, exactly one write, exclusive and 0600, path refused inside the repo.
 *   A13  never in the app: no import of scripts/proof, and no tracked Metro config names the probe flag or entry.
 *
 * Every forbidden literal is assembled by concatenation, so this file cannot trip its own scan. The planted
 * describe block proves each rule can fail. A violation that sits only inside a comment is not reported.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const PROOF_DIR = path.join(REPO, 'scripts', 'proof');
const APP_DIR = path.join(REPO, 'apps', 'VoteTorrentAuthority');

// A later regeneration of the vector needs a deliberate change here AND in the vector file. That blocks a quiet
// "fix" of a Hermes mismatch (PD-14): a mismatch is recorded and brought back, never worked around.
const PINNED_VECTOR_ID = '823124f2249c0650';

const PROBES_FLAG = 'VT64_' + 'PROBES';
const ENTRY_DOT = 'probe-entry' + '.';
const SET_ITEM = 'set' + 'Item';

const KAT_FILE = 'dkg-kat-probe.ts';
const CAP_FILE = 'association-capture-probe.ts';
const ENTRY_FILE = ENTRY_DOT + 'authority.js';
const READER_FILE = 'read-association-capture.mjs';
const VECTOR_FILE = 'dkg-kat-vector.json';

const KAT_RESULT_KEYS = ['v', 'probe', 'state', 'pass', 'rounds', 'checks', 'mismatches', 'mismatchIndex', 'mismatchName', 'katMs', 'liveRuns', 'livePass', 'liveMs', 'ms', 'vectorId', 'error', 'ignoredStarts'];
const CAP_RESULT_KEYS = ['v', 'probe', 'state', 'rows', 'devices', 'chunks', 'rawSha256', 'ms', 'error', 'ignoredStarts'];
const CAP_DEVICE_KEYS = ['deviceIdPrefix', 'registrantIdPrefix', 'type', 'hasChains'];

const CAP_MEMBER_CALLS = ['ceil', 'eval', 'from', 'getEngine', 'getFiberRoots', 'info', 'isArray', 'isInteger', 'join', 'keys', 'map', 'now', 'parse', 'pop', 'push', 'replace', 'slice', 'split', 'stringify', 'test', 'then'];

const KAT_CHECK_NAMES = [
	'identifier:a', 'identifier:b', 'commit:a', 'commit:b', 'verify-commit:a', 'verify-commit:b', 'verify-commit:wrong-attempt',
	'verify-package:a-checks-b', 'verify-package:b-checks-a', 'verify-package:tampered-pok', 'round2:a-to-b', 'round2:b-to-a',
	'dealer-share:a-to-b', 'dealer-share:b-to-a', 'dealer-share:wrong-recipient', 'decrypt-share:a-to-b', 'decrypt-share:b-to-a',
	'round3:a', 'round3:b', 'derive-group-commitments', 'validate-released:a', 'validate-released:b', 'validate-released:flipped',
	'reconstruct', 'secret-roundtrip:a-step1', 'secret-roundtrip:b-step1', 'secret-roundtrip:a-step2', 'secret-roundtrip:b-step2',
];

const DENY_CALLS = [
	SET_ITEM, 'removeItem', 'multiSet', 'multiRemove', 'mergeItem', 'multiMerge', 'clear', 'writeFile', 'appendFile', 'unlink',
	'run', 'exec', 'transaction', 'commit', 'submit', 'approve', 'reject', 'publish', 'associate', 'sync', 'create', 'insert',
	'update', 'delete', 'upsert', 'storeSecret', 'putSecret', 'setSecret', 'deleteSecret', 'produce', 'produceAttestation',
	'produceFreshAttestation', 'signDeviceKeyDigest', 'createCadreInvitation', 'joinNetwork', 'addStrand',
];

const SQL_WRITE_VERBS = /\b(insert|update|delete|replace|upsert|create|drop|alter|attach|pragma|begin|commit|rollback)\b/i;

// ---------------------------------------------------------------------------
// Pure text helpers
// ---------------------------------------------------------------------------

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
	return noBlockComments.replace(/\/\/.*$/gm, '');
}

function matchingClose(s: string, open: number, openCh: string, closeCh: string): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === openCh) depth++;
		else if (s[i] === closeCh) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return s.length - 1;
}

function loopBodies(s: string): string[] {
	const out: string[] = [];
	const re = /\b(?:for|while)\s*(?:await\s*)?\(|\bdo\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const last = m.index + m[0].length - 1;
		if (s[last] === '{') {
			out.push(s.slice(last, matchingClose(s, last, '{', '}') + 1));
			continue;
		}
		const close = matchingClose(s, last, '(', ')');
		let i = close + 1;
		while (i < s.length && /\s/.test(s[i]!)) i++;
		if (s[i] === '{') {
			out.push(s.slice(i, matchingClose(s, i, '{', '}') + 1));
		} else {
			// A brace-less body is the rest of its line.
			const eol = s.indexOf('\n', i);
			out.push(s.slice(i, eol === -1 ? s.length : eol));
		}
	}
	return out;
}

function memberCalls(s: string): string[] {
	return [...s.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
}

function importSpecifiers(s: string): string[] {
	const out: string[] = [];
	for (const m of s.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s*)?'([^']+)'/g)) out.push(m[1]!);
	for (const m of s.matchAll(/\brequire\s*\(\s*'([^']+)'/g)) out.push(m[1]!);
	for (const m of s.matchAll(/\bimport\s*\(\s*'([^']+)'/g)) out.push(m[1]!);
	return out;
}

function bodyAfter(s: string, from: number): string {
	const open = s.indexOf('{', from);
	if (open === -1) return '';
	return s.slice(open, matchingClose(s, open, '{', '}') + 1);
}

function keyList(s: string, name: string): string[] | null {
	const m = new RegExp(`\\b${name}\\s*(?::\\s*string\\[\\])?\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(s);
	if (!m) return null;
	return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

function sameList(a: string[] | null, b: string[]): boolean {
	return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Rule checkers: each returns readable violation strings that start with the rule id
// ---------------------------------------------------------------------------

function checkSql(s: string, label: string, minEvals: number, mustName: string | null): string[] {
	const out: string[] = [];
	let count = 0;
	for (const m of s.matchAll(/\.eval\s*\(/g)) {
		count++;
		const rest = s.slice(m.index! + m[0].length);
		const lit = /^\s*'([^'\\\n]*)'/.exec(rest);
		if (!lit) {
			out.push(`A1: ${label} eval argument is not one single-quoted literal`);
			continue;
		}
		if (!/^\s*select\s/i.test(lit[1]!)) out.push(`A1: ${label} eval literal is not a select`);
		if (SQL_WRITE_VERBS.test(lit[1]!)) out.push(`A1: ${label} eval literal holds a write verb`);
		if (mustName !== null && !lit[1]!.includes(mustName)) out.push(`A1: ${label} eval literal does not name ${mustName}`);
	}
	if (count < minEvals) out.push(`A1: ${label} has ${count} eval calls, expected at least ${minEvals}`);
	if (minEvals === 0 && count !== 0) out.push(`A1: ${label} has ${count} eval calls, expected 0`);
	return out;
}

function checkDeny(s: string, label: string, extra: string[]): string[] {
	const out: string[] = [];
	const names = memberCalls(s);
	for (const bad of [...DENY_CALLS, ...extra]) {
		if (names.includes(bad)) out.push(`A2: ${label} calls ${bad}`);
	}
	if (/\bprovision\w*\s*\(/.test(s)) out.push(`A2: ${label} calls a provisioning function`);
	for (const id of ['AsyncStorage', 'RNFS', 'Keychain']) {
		if (new RegExp(`\\b${id}\\b`).test(s)) out.push(`A2: ${label} names ${id}`);
	}
	return out;
}

function checkConsole(s: string, label: string): string[] {
	const out: string[] = [];
	const re = /console\s*\.\s*(\w+)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const open = m.index + m[0].length - 1;
		const arg = s.slice(open + 1, matchingClose(s, open, '(', ')'));
		if (!/^\s*'[^'\\\n]*'\s*$/.test(arg)) out.push(`A5: ${label} console.${m[1]} takes more than one string literal`);
	}
	return out;
}

function checkClosedShape(s: string, label: string, keys: string[], deviceKeys: string[] | null): string[] {
	const out: string[] = [];
	if (!sameList(keyList(s, 'RESULT_KEYS'), keys)) out.push(`A6: ${label} RESULT_KEYS differs from the pinned list`);
	if (deviceKeys !== null && !sameList(keyList(s, 'DEVICE_KEYS'), deviceKeys)) out.push(`A6: ${label} DEVICE_KEYS differs from the pinned list`);
	for (const m of s.matchAll(/\blatest\s*=(?!=)([^\n]*)/g)) {
		const rhs = m[1]!.trim();
		if (!(rhs.startsWith('closedJson(') || rhs === 'null')) out.push(`A6: ${label} assigns latest from something other than closedJson`);
	}
	if (!/\breturn latest\b/.test(s)) out.push(`A6: ${label} never returns latest`);
	if (!/\bconst TOKEN_RE\s*=/.test(s) || !/\bconst HEX_RE\s*=/.test(s)) out.push(`A6: ${label} does not declare TOKEN_RE and HEX_RE`);
	const fn = /function closedJson\s*\(/.exec(s);
	if (!fn || !bodyAfter(s, fn.index + fn[0].length).includes('RESULT_KEYS')) out.push(`A6: ${label} closedJson does not name RESULT_KEYS`);
	return out;
}

const RAW_ALLOWED: RegExp[] = [
	/^\s*let rawJson: string \| null = null\s*$/,
	/^\s*rawJson = JSON\.stringify\(doc\)\s*$/,
	/^\s*rawJson = null\s*$/,
	/utf8ToBytes\(rawJson\)/,
	/\brawJson\.length\b/,
	/\brawJson\.slice\(/,
	/\brawJson (?:===|!==) null/,
];

function checkRawChannel(s: string, label: string, isCapture: boolean): string[] {
	const out: string[] = [];
	if (!isCapture) {
		if (/\brawChunk\w*/.test(s)) out.push(`A7: ${label} names the raw channel`);
		if (/\brawJson\b/.test(s)) out.push(`A7: ${label} names rawJson`);
		return out;
	}
	for (const line of s.split('\n')) {
		if (!/\brawJson\b/.test(line)) continue;
		if (!RAW_ALLOWED.some((re) => re.test(line))) out.push(`A7: ${label} has a rawJson line outside the allowed forms: ${line.trim()}`);
		if (line.includes('closedJson(') || line.includes('console.')) out.push(`A7: ${label} puts rawJson on a result or log line`);
	}
	return out;
}

function registrationsOf(s: string): string[] {
	return [...s.matchAll(/__vt64Probes\s*\.\s*(\w+)\s*=(?!=)/g)].map((m) => m[1]!);
}

function checkRegistry(s: string, label: string, expectNames: string[]): string[] {
	const out: string[] = [];
	if (JSON.stringify(registrationsOf(s)) !== JSON.stringify(expectNames)) out.push(`A8: ${label} registers [${registrationsOf(s).join(',')}], expected [${expectNames.join(',')}]`);
	for (const m of s.matchAll(/__vt64Probes\s*\.\s*(\w+)\s*=\s*\{([^}]*)\}/g)) {
		for (const entry of m[2]!.split(',')) {
			const e = entry.trim();
			if (e === '') continue;
			const value = e.includes(':') ? e.slice(e.indexOf(':') + 1).trim() : e;
			if (!/^[A-Za-z_$][\w$]*$/.test(value)) out.push(`A8: ${label} registry value is not a bare identifier: ${e}`);
		}
	}
	if (/async\s+function\s+(?:start|result|rawChunk)/.test(s)) out.push(`A8: ${label} has an async registry function`);
	for (const m of s.matchAll(/function\s+(register\w*Probe)\s*\(/g)) {
		const close = matchingClose(s, m.index! + m[0].length - 1, '(', ')');
		if (!bodyAfter(s, close).includes('__DEV__')) out.push(`A8: ${label} ${m[1]} body has no __DEV__ guard`);
	}
	return out;
}

function checkRegistryUnique(files: Array<{ name: string, text: string }>): string[] {
	const seen = new Map<string, string>();
	const out: string[] = [];
	for (const f of files) {
		for (const n of registrationsOf(stripCommentsPreservingLines(f.text))) {
			const prev = seen.get(n);
			if (prev !== undefined && prev !== f.name) out.push(`A8: probe name ${n} is registered in both ${prev} and ${f.name}`);
			seen.set(n, f.name);
		}
	}
	return out;
}

function checkEntryRegistration(s: string, firstImport: string, registerCalls: string[]): string[] {
	const out: string[] = [];
	const specs = importSpecifiers(s);
	if (specs[0] !== firstImport) out.push(`A8: entry first import is ${String(specs[0])}, expected ${firstImport}`);
	const guard = /if\s*\(\s*__DEV__\s*\)\s*\{/.exec(s);
	if (!guard) {
		out.push('A8: entry has no if (__DEV__) block');
		return out;
	}
	const open = guard.index + guard[0].length - 1;
	const body = s.slice(open, matchingClose(s, open, '{', '}') + 1);
	const outside = s.slice(0, open) + s.slice(open + body.length);
	for (const call of registerCalls) {
		if (!body.includes(call + '(')) out.push(`A8: entry does not call ${call} inside if (__DEV__)`);
		const calls = outside.split('\n').filter((l) => !/^\s*import\b/.test(l) && !/^\s*\}?\s*from\b/.test(l) && l.includes(call + '('));
		if (calls.length > 0) out.push(`A8: entry calls ${call} outside if (__DEV__)`);
	}
	return out;
}

function checkHermes(s: string, label: string): string[] {
	const out: string[] = [];
	for (const body of loopBodies(s)) {
		if (body.includes('=>') || /\bfunction\b/.test(body)) out.push(`A9: ${label} builds a closure inside a loop`);
	}
	return out;
}

function checkVector(text: string, pinned: string): string[] {
	const out: string[] = [];
	let v: any;
	try {
		v = JSON.parse(text);
	} catch {
		return ['A10: the vector does not parse'];
	}
	if (v.v !== 1 || v.kind !== 'vt64-dkg-kat') out.push('A10: vector v/kind');
	if (v.vectorId !== pinned) out.push('A10: vectorId differs from the pinned value');
	if (!v.params || !v.params.ctx || v.params.ctx.electionId !== 'vt64-kat-election') out.push('A10: ctx election id is not the reserved one');
	if (!v.params || v.params.threshold !== 2 || v.params.participants !== 2) out.push('A10: threshold/participants are not 2/2');
	const names = Array.isArray(v.checks) ? v.checks.map((c: any) => c && c.name) : [];
	if (JSON.stringify(names) !== JSON.stringify(KAT_CHECK_NAMES)) out.push('A10: check names differ from the pinned 28');
	if (typeof v.safety !== 'string' || !v.safety.includes('vt64-kat-election')) out.push('A10: safety sentence does not name the reserved election id');
	for (const word of ['vtjoin', 'sereus-invite' + ':', 'invite' + 'Private']) {
		if (text.includes(word)) out.push(`A10: the vector holds join material (${word})`);
	}
	return out;
}

function checkReader(raw: string): string[] {
	const out: string[] = [];
	if (raw.includes('child_' + 'process')) out.push('A12: the reader imports a child process');
	const writes = [...raw.matchAll(/writeFileSync\(/g)];
	if (writes.length !== 1) {
		out.push(`A12: the reader has ${writes.length} writeFileSync calls, expected 1`);
	} else {
		const callText = raw.slice(writes[0]!.index!, matchingClose(raw, writes[0]!.index! + 'writeFileSync'.length, '(', ')') + 1);
		if (!callText.includes("flag: 'wx'") || !callText.includes('0o600')) out.push('A12: the write is not exclusive and 0600');
		const guards = [...raw.matchAll(/assertOutsideRepo\(/g)];
		if (guards.length < 2) out.push('A12: assertOutsideRepo is not used');
		else if (guards[0]!.index! > writes[0]!.index!) out.push('A12: the repo guard does not precede the write');
	}
	return out;
}

function checkNeverInApp(files: Array<{ name: string, text: string }>, proofBases: string[], metroText: string): string[] {
	const out: string[] = [];
	for (const f of files) {
		for (const spec of importSpecifiers(stripCommentsPreservingLines(f.text))) {
			const bare = spec.replace(/\.(?:tsx?|jsx?|mjs|json)$/, '');
			if (spec.includes('scripts/proof') || proofBases.some((b) => bare === b || bare.endsWith('/' + b))) {
				out.push(`A13: ${f.name} imports ${spec}`);
			}
		}
	}
	if (metroText.includes(PROBES_FLAG) || metroText.includes('probe-' + 'entry')) out.push('A13: the tracked Metro config names the probe flag or entry');
	return out;
}

// Whole-file checkers
function checkKat(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw);
	const out: string[] = [];
	out.push(...checkSql(s, 'KAT', 0, null));
	out.push(...checkDeny(s, 'KAT', []));
	if (/\bgetEngine\b|__REACT_DEVTOOLS_GLOBAL_HOOK__/.test(s)) out.push('A3: KAT names an engine or the devtools hook');
	if (importSpecifiers(s).some((x) => x.includes('react-native'))) out.push('A3: KAT imports react-native');
	out.push(...checkConsole(s, 'KAT'));
	out.push(...checkClosedShape(s, 'KAT', KAT_RESULT_KEYS, null));
	out.push(...checkRawChannel(s, 'KAT', false));
	out.push(...checkRegistry(s, 'KAT', ['dkgKat']));
	out.push(...checkHermes(s, 'KAT'));
	if (JSON.stringify(importSpecifiers(s)) !== JSON.stringify(['../../packages/vote-engine/dist/crypto/dkg.js'])) out.push('A11: KAT import specifiers differ from the single dist dkg module');
	if (s.includes('toLowerCase(') || s.includes('.trim(')) out.push('A11: KAT normalises a string');
	if (s.includes('require(')) out.push('A11: KAT uses require');
	return out;
}

function checkCap(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw);
	const out: string[] = [];
	out.push(...checkSql(s, 'CAP', 1, 'from AssociationPrivate'));
	out.push(...checkDeny(s, 'CAP', []));
	const names = [...new Set(memberCalls(s))].sort();
	if (JSON.stringify(names) !== JSON.stringify(CAP_MEMBER_CALLS)) out.push(`A3: CAP member calls differ from the pinned set: ${names.join(',')}`);
	const engines = [...s.matchAll(/getEngine\s*\(\s*'([^']*)'/g)].map((m) => m[1]!);
	const allEngineCalls = [...s.matchAll(/getEngine\s*\(/g)].length;
	if (engines.length !== allEngineCalls) out.push('A4: CAP calls getEngine with a non-literal name');
	for (const n of engines) {
		if (!['association'].includes(n)) out.push(`A4: CAP names engine ${n}`);
	}
	out.push(...checkConsole(s, 'CAP'));
	out.push(...checkClosedShape(s, 'CAP', CAP_RESULT_KEYS, CAP_DEVICE_KEYS));
	out.push(...checkRawChannel(s, 'CAP', true));
	out.push(...checkRegistry(s, 'CAP', ['associationCapture']));
	out.push(...checkHermes(s, 'CAP'));
	if (s.includes('require(')) out.push('A11: CAP uses require');
	return out;
}

function checkEntry(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw);
	const out: string[] = [];
	out.push(...checkSql(s, 'ENTRY', 0, null));
	out.push(...checkDeny(s, 'ENTRY', []));
	out.push(...checkConsole(s, 'ENTRY'));
	out.push(...checkRawChannel(s, 'ENTRY', false));
	out.push(...checkRegistry(s, 'ENTRY', []));
	out.push(...checkEntryRegistration(s, '../../apps/VoteTorrentAuthority/index.js', ['registerDkgKatProbe', 'registerAssociationCaptureProbe']));
	out.push(...checkHermes(s, 'ENTRY'));
	if (s.includes('require(')) out.push('A11: ENTRY uses require');
	return out;
}

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

function read(name: string): string {
	const p = path.join(PROOF_DIR, name);
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const KAT = read(KAT_FILE);
const CAP = read(CAP_FILE);
const ENTRY = read(ENTRY_FILE);
const READER = read(READER_FILE);
const VECTOR = read(VECTOR_FILE);

function proofCodeFiles(): Array<{ name: string, text: string }> {
	return fs.readdirSync(PROOF_DIR)
		.filter((n) => /\.(?:ts|tsx|js|mjs)$/.test(n))
		.map((n) => ({ name: n, text: fs.readFileSync(path.join(PROOF_DIR, n), 'utf8') }));
}

function appSourceFiles(): Array<{ name: string, text: string }> {
	const out: Array<{ name: string, text: string }> = [];
	const self = path.join(__dirname, 'rig-probes.gate.test.ts');
	const walk = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules') continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.(?:ts|tsx|js)$/.test(e.name) && full !== self) out.push({ name: path.relative(APP_DIR, full), text: fs.readFileSync(full, 'utf8') });
		}
	};
	walk(path.join(APP_DIR, 'src'));
	for (const n of ['index.js', 'App.tsx']) {
		const full = path.join(APP_DIR, n);
		if (fs.existsSync(full)) out.push({ name: n, text: fs.readFileSync(full, 'utf8') });
	}
	return out;
}

function proofBases(): string[] {
	return fs.readdirSync(PROOF_DIR).map((n) => n.replace(/\.(?:tsx?|jsx?|mjs|json)$/, ''));
}

const METRO = fs.readFileSync(path.join(APP_DIR, 'metro.config.js'), 'utf8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rig probes gate (T-64-20, Authority side)', () => {
	it('resolves every real file (path sanity)', () => {
		for (const n of [KAT_FILE, CAP_FILE, ENTRY_FILE, READER_FILE, VECTOR_FILE]) {
			expect(fs.existsSync(path.join(PROOF_DIR, n))).toBe(true);
		}
	});

	it('the probe files hold no URL scheme separator, so the line-comment stripper is safe on them', () => {
		for (const raw of [KAT, CAP, ENTRY]) expect(raw.includes('://')).toBe(false);
	});

	it('is not vacuous: the scans see the content each rule depends on', () => {
		expect(CAP).toContain("from AssociationPrivate'");
		expect(KAT).toContain("'dkg-kat-probe/1'");
		expect(proofCodeFiles().length).toBeGreaterThanOrEqual(8);
		expect(loopBodies(stripCommentsPreservingLines(KAT)).length).toBeGreaterThan(2);
		expect(memberCalls(stripCommentsPreservingLines(CAP)).length).toBeGreaterThan(20);
	});

	it('A1 SQL: the capture probe has one select literal and the others have none', () => {
		expect(checkSql(stripCommentsPreservingLines(CAP), 'CAP', 1, 'from AssociationPrivate')).toEqual([]);
		expect(checkSql(stripCommentsPreservingLines(KAT), 'KAT', 0, null)).toEqual([]);
		expect(checkSql(stripCommentsPreservingLines(ENTRY), 'ENTRY', 0, null)).toEqual([]);
	});

	it('A2 deny-list: no storage, vault, release, seeding, provisioning or write call in any probe', () => {
		for (const [label, raw] of [['KAT', KAT], ['CAP', CAP], ['ENTRY', ENTRY]] as const) {
			expect(checkDeny(stripCommentsPreservingLines(raw), label, [])).toEqual([]);
		}
	});

	it('A3 allow-lists: the capture probe member calls are the pinned set; the KAT probe has no engine, hook or RN', () => {
		expect(checkCap(CAP).filter((v) => v.startsWith('A3'))).toEqual([]);
		expect(checkKat(KAT).filter((v) => v.startsWith('A3'))).toEqual([]);
	});

	it('A4 the capture probe names only the association engine', () => {
		expect(checkCap(CAP).filter((v) => v.startsWith('A4'))).toEqual([]);
		expect([...stripCommentsPreservingLines(CAP).matchAll(/getEngine\s*\(\s*'([^']*)'/g)].map((m) => m[1])).toEqual(['association']);
	});

	it('A5 every console call takes one string literal', () => {
		for (const [label, raw] of [['KAT', KAT], ['CAP', CAP], ['ENTRY', ENTRY]] as const) {
			expect(checkConsole(stripCommentsPreservingLines(raw), label)).toEqual([]);
		}
	});

	it('A6 closed shape: pinned keys and every result goes through closedJson', () => {
		expect(checkClosedShape(stripCommentsPreservingLines(KAT), 'KAT', KAT_RESULT_KEYS, null)).toEqual([]);
		expect(checkClosedShape(stripCommentsPreservingLines(CAP), 'CAP', CAP_RESULT_KEYS, CAP_DEVICE_KEYS)).toEqual([]);
	});

	it('A7 raw channel: rawChunk and rawJson live only in the capture probe, on the allowed lines', () => {
		expect(checkRawChannel(stripCommentsPreservingLines(CAP), 'CAP', true)).toEqual([]);
		expect(checkRawChannel(stripCommentsPreservingLines(KAT), 'KAT', false)).toEqual([]);
		expect(checkRawChannel(stripCommentsPreservingLines(ENTRY), 'ENTRY', false)).toEqual([]);
		expect(stripCommentsPreservingLines(CAP)).toContain('rawChunk');
	});

	it('A8 registry: one registration per name across every scripts/proof file, with __DEV__ guards', () => {
		expect(checkRegistry(stripCommentsPreservingLines(KAT), 'KAT', ['dkgKat'])).toEqual([]);
		expect(checkRegistry(stripCommentsPreservingLines(CAP), 'CAP', ['associationCapture'])).toEqual([]);
		expect(checkEntry(ENTRY)).toEqual([]);
		expect(checkRegistryUnique(proofCodeFiles())).toEqual([]);
	});

	it('A9 Hermes: no closure inside a loop body', () => {
		for (const [label, raw] of [['KAT', KAT], ['CAP', CAP], ['ENTRY', ENTRY]] as const) {
			expect(checkHermes(stripCommentsPreservingLines(raw), label)).toEqual([]);
		}
	});

	it('A10 vector: shape, pinned vectorId, reserved election id, 28 check names, no join material', () => {
		expect(checkVector(VECTOR, PINNED_VECTOR_ID)).toEqual([]);
	});

	it('A11 the KAT probe imports only the dist dkg module and never normalises', () => {
		expect(checkKat(KAT).filter((v) => v.startsWith('A11'))).toEqual([]);
		expect(checkCap(CAP).filter((v) => v.startsWith('A11'))).toEqual([]);
		expect(checkEntry(ENTRY).filter((v) => v.startsWith('A11'))).toEqual([]);
	});

	it('A12 the host reader: no child process, one exclusive 0600 write, repo guard first', () => {
		expect(checkReader(READER)).toEqual([]);
	});

	it('A13 never in the app: no import of scripts/proof and no probe name in the Metro config', () => {
		const files = appSourceFiles();
		expect(files.length).toBeGreaterThan(20);
		expect(checkNeverInApp(files, proofBases(), METRO)).toEqual([]);
	});

	it('the whole-file checkers report nothing on the real files', () => {
		expect(checkKat(KAT)).toEqual([]);
		expect(checkCap(CAP)).toEqual([]);
		expect(checkEntry(ENTRY)).toEqual([]);
	});

	describe('planted mutations (each rule can fail)', () => {
		const plantKat = (extra: string): string[] => checkKat(KAT + '\n' + extra + '\n');
		const plantCap = (extra: string): string[] => checkCap(CAP + '\n' + extra + '\n');
		const has = (v: string[], id: string): boolean => v.some((x) => x.startsWith(id));

		it('A1 planted: a delete statement and a backtick literal are reported', () => {
			expect(has(plantCap("async function x(db: any) { for await (const r of db.eval('delete from AssociationPrivate', {})) { void r } }"), 'A1')).toBe(true);
			expect(has(plantCap('async function x(db: any) { for await (const r of db.eval(`select 1`, {})) { void r } }'), 'A1')).toBe(true);
			expect(has(plantKat("function x(db: any) { return db.eval('select 1', {}) }"), 'A1')).toBe(true);
		});

		it('A2 planted: a storage write and a provisioning call are reported', () => {
			expect(has(plantCap('async function x() { await AsyncStorage.' + SET_ITEM + "('k', 'v') }"), 'A2')).toBe(true);
			expect(has(plantKat('async function x(u: any) { await provisionDeviceKey(u) }'), 'A2')).toBe(true);
			expect(has(plantCap('function x(e: any) { e.joinNetwork() }'), 'A2')).toBe(true);
		});

		it('A3 planted: a new member call breaks the pinned set, and an engine in the KAT probe is reported', () => {
			expect(has(plantCap('function x(t: any) { t.insertRow(1) }'), 'A3')).toBe(true);
			expect(has(plantKat("function x(c: any) { return c.getEngine('x') }"), 'A3')).toBe(true);
		});

		it('A4 planted: a second engine name is reported', () => {
			expect(has(plantCap("async function x(c: any) { return c.getEngine('registration') }"), 'A4')).toBe(true);
		});

		it('A5 planted: a console call with a variable is reported', () => {
			expect(has(plantCap('function x(rawJson: string) { console.log(rawJson) }'), 'A5')).toBe(true);
			expect(has(plantKat("function x(a: string) { console.info('a' + a) }"), 'A5')).toBe(true);
		});

		it('A6 planted: an extra result key and a non-closed latest are reported', () => {
			expect(has(checkKat(KAT.replace("'v',", "'v', 'extraKey',")), 'A6')).toBe(true);
			expect(has(checkCap(CAP.replace("'type',", "'type', 'extraKey',")), 'A6')).toBe(true);
			expect(has(plantKat('function x(o: any) { latest = JSON.stringify(o) }'), 'A6')).toBe(true);
		});

		it('A7 planted: rawJson on a log line and the raw channel in the KAT probe are reported', () => {
			expect(has(plantCap('function x() { console.info(rawJson) }'), 'A7')).toBe(true);
			expect(has(plantCap('function x() { return closedJson({ a: rawJson }) }'), 'A7')).toBe(true);
			expect(has(plantKat('function rawChunkKat(i: number) { return i }'), 'A7')).toBe(true);
		});

		it('A8 planted: a duplicate name across files, an async start and an unguarded entry call are reported', () => {
			expect(has(checkRegistryUnique([{ name: 'one.ts', text: KAT }, { name: 'two.ts', text: KAT }]), 'A8')).toBe(true);
			expect(has(plantKat('async function startDkgKat(a: string) { return a }'), 'A8')).toBe(true);
			expect(has(checkEntry(ENTRY.replace('if (__DEV__) {', 'if (true) {')), 'A8')).toBe(true);
			expect(has(checkEntry(ENTRY.replace("import '../../apps/VoteTorrentAuthority/index.js';", '')), 'A8')).toBe(true);
		});

		it('A9 planted: a closure pushed inside a loop is reported', () => {
			expect(has(plantKat('function x(rows: number[], fns: any[]) { for (const r of rows) { fns.push(() => r) } }'), 'A9')).toBe(true);
			expect(has(plantCap('function x(rows: number[], fns: any[]) { while (rows.length > 0) { fns.push(function () { return 1 }) } }'), 'A9')).toBe(true);
		});

		it('A10 planted: another election id and another vectorId are reported', () => {
			expect(has(checkVector(VECTOR.replace('"electionId": "vt64-kat-election"', '"electionId": "other-election"'), PINNED_VECTOR_ID), 'A10')).toBe(true);
			expect(has(checkVector(VECTOR.replace(PINNED_VECTOR_ID, '0000000000000000'), PINNED_VECTOR_ID), 'A10')).toBe(true);
			expect(has(checkVector(VECTOR.replace('"identifier:a"', '"identifier:z"'), PINNED_VECTOR_ID), 'A10')).toBe(true);
		});

		it('A11 planted: a second import and a lowercase normalisation are reported', () => {
			expect(has(checkKat("import x from './other'\n" + KAT), 'A11')).toBe(true);
			expect(has(plantKat('function x(a: string) { return a.toLowerCase() }'), 'A11')).toBe(true);
			expect(has(plantCap("const m = require('x')"), 'A11')).toBe(true);
		});

		it('A12 planted: a write without options and a child process are reported', () => {
			const planted = READER.replace("fs.writeFileSync(path.join(outDir, fileName), raw, { mode: 0o600, flag: 'wx' })", 'fs.writeFileSync(path.join(outDir, fileName), raw)');
			expect(planted).not.toBe(READER);
			expect(has(checkReader(planted), 'A12')).toBe(true);
			expect(has(checkReader(READER + "\nimport { execFileSync } from 'node:child_" + "process'\n"), 'A12')).toBe(true);
		});

		it('A13 planted: an app import of a probe and a Metro config naming the flag are reported', () => {
			const planted = [{ name: 'planted.ts', text: "import x from '../../../../scripts/proof/dkg-kat-probe'\n" }];
			expect(has(checkNeverInApp(planted, proofBases(), METRO), 'A13')).toBe(true);
			expect(has(checkNeverInApp([], proofBases(), METRO + '\n// ' + PROBES_FLAG + '\n'), 'A13')).toBe(true);
			expect(has(checkNeverInApp([{ name: 'p.ts', text: "import x from './decrypt-probe'" }], proofBases(), METRO), 'A13')).toBe(true);
		});

		it('P-comment: every planted violation placed only inside comments reports nothing', () => {
			const commented = [
				"// db.eval('delete from AssociationPrivate', {})",
				'// AsyncStorage.' + SET_ITEM + "('k', 'v'); provisionDeviceKey(u); e.joinNetwork(); t.insertRow(1)",
				"/* c.getEngine('registration'); console.log(rawJson); latest = JSON.stringify(o) */",
				"// import x from './other'; a.toLowerCase(); function rawChunkKat() {}",
				'// for (const r of rows) { fns.push(() => r) }',
			].join('\n');
			expect(checkKat(KAT + '\n' + commented + '\n')).toEqual([]);
			expect(checkCap(CAP + '\n' + commented + '\n')).toEqual([]);
			expect(checkEntry(ENTRY + '\n' + commented + '\n')).toEqual([]);
			expect(checkNeverInApp([{ name: 'c.ts', text: "// import x from '../../../../scripts/proof/dkg-kat-probe'\n" }], proofBases(), METRO)).toEqual([]);
		});
	});
});
