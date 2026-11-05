#!/usr/bin/env node
/**
 * assert-evidence-dir.mjs
 *
 * The single gate over the two evidence roots of the join-and-vote-pool phase: the host root (a directory named
 * 64-evidence) and the device root (a directory named 64-device-evidence). It enforces, and nothing else:
 *   - the never-in-evidence list (value-shaped secret rules, the raw association capture shape, tool-call markup,
 *     forbidden file types and links);
 *   - the attempt chains (numbering, one verdict per leg, a log per failure, a reason per retry), the session rules
 *     (run summaries, the failure index), the coverage statement and the wall-gate first line, the ledger, the
 *     command-log rules and the sha256 sum files;
 *   - with the git flag, append-only history of attempt files, logs and verdicts (committed or still uncommitted);
 *   - with the streak flag, that the last K runs of a rehearsal session each passed on the first attempt. Four declared
 *     restart chains are accepted and nothing else, all on run-1 only. E7 (notes 19 E7): attempts exactly attempt-1
 *     and attempt-2, an attempt-level attempt-2/reason.txt of one line "RESTART notes-19-e7: <why>", and an attempt-1
 *     holding at least one non-PASS leg. E12 (notes 19 E12, 64-55): attempts exactly attempt-1, attempt-2 and
 *     attempt-3, attempt-2/reason.txt the one e7 line, attempt-3/reason.txt one line "RESTART notes-19-e12: <why>", and
 *     attempt-1 and attempt-2 each holding at least one non-PASS leg. E15 (notes 19 E15, 64-56): attempts exactly
 *     attempt-1 to attempt-4, attempt-2 the e7 line, attempt-3 the e12 line, attempt-4/reason.txt one line
 *     "RESTART notes-19-e15: <why>", and attempts 1, 2 and 3 each holding at least one non-PASS leg. E23 (notes 19 E23,
 *     64-60) is the same four-attempt chain with attempt-4/reason.txt one line "RESTART notes-19-e23: <why>" in place of
 *     the e15 line (the attempt-5 redo of run 1 on a fresh party). The streak then reads the last attempt (attempt-2,
 *     attempt-3, attempt-4 or attempt-5); every other retry stays a streak-retried finding. E77 (notes 19 E77,
 *     64-57) adds the five-attempt chain: the E15 or E23 chain plus attempt-5/reason.txt one line
 *     "RESTART notes-19-e77: <why>", attempts 1 to 4 each holding at least one non-PASS leg (run 1 redone after
 *     attempt-4 stopped with the officer Authority killed for memory). E81 (notes 19 E81, 64-57) adds the six-attempt
 *     chain: the E77 chain plus attempt-6/reason.txt one line "RESTART notes-19-e81: <why>", attempts 1 to 5 each
 *     holding at least one non-PASS leg (run 1 redone after attempt-5 stopped at the ballot sign, the officer AVD swapping).
 *     E83 (notes 19 E83, 64-57) adds the seven-attempt chain: the E81 chain plus attempt-7/reason.txt one line
 *     "RESTART notes-19-e83: <why>", attempts 1 to 6 each holding at least one non-PASS leg (run 1 redone after
 *     attempt-6 stopped at the ballot form, the officer JS thread starved).
 *     E84 (notes 19 E84, 64-57) adds the eight-attempt chain: the E83 chain plus attempt-8/reason.txt one line
 *     "RESTART notes-19-e84: <why>", attempts 1 to 7 each holding at least one non-PASS leg (run 1 redone after
 *     attempt-7 stopped at the Redmi accept, a prompt answered at 123 s).
 *     E85 (notes 19 E85, 64-57) adds the nine-attempt chain: the E84 chain plus attempt-9/reason.txt one line
 *     "RESTART notes-19-e85: <why>", attempts 1 to 8 each holding at least one non-PASS leg (run 1 redone after
 *     attempt-8 stopped at the ballot sign, the sign screen leaving at 194 s).
 *     E86 (notes 19 E86, 64-57) adds the ten-attempt chain: the E85 chain plus attempt-10/reason.txt one line
 *     "RESTART notes-19-e86: <why>", attempts 1 to 9 each holding at least one non-PASS leg (run 1 redone on a fresh
 *     n7 after the full rig wipe; attempt-9 stopped at the ballot propose).
 *
 * Modes:
 *   [--git] [--secrets-file <abs>] [--streak <K> [--session <abs dir>] [--legs a,b]] <path>...
 *   --selftest     materialise every case under fixtures/evidence-dir in a temporary dir and run the checker on it
 *
 * Output: one finding line per finding, naming a closed token and a path. The matched text is never printed; details
 * are counts, line numbers and short hash prefixes. The last line is a PASS or FAIL summary. Exit 0 for a pass, 1 for
 * findings, 2 for an instrument or usage error (a line starting ERROR with a closed token).
 *
 * Every rule is value-shaped: a bare mention of a prefix or a field name passes. The selftest proves that each rule can
 * fail (one planted case per token) and that each rule family can be switched off by a mutation, which makes the
 * selftest itself fail. A mutation is honoured only under the selftest; any other run that sets one is refused.
 * Every pattern below is assembled from fragments, so this file never holds the literal it hunts; the selftest also
 * runs every text rule over this file, the raw fixtures and the replay sources to prove none of them trips.
 *
 * The checker only reads. Every git call is read-only and takes no optional locks.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FIXTURES = join(HERE, 'fixtures', 'evidence-dir');
const SELF = fileURLToPath(import.meta.url);
const REPLAY_REL = ['.planning', 'phases', '64-join-and-vote-pool-on-phones-a-qr-for-the-join-code-and-the-', '64-device-evidence', 'replay'];
const MUTATE = process.env.EVIDENCE_MUTATE ?? '';
const MUTATIONS = [
	'no-secret-grep',
	'no-markup-grep',
	'no-file-rules',
	'no-attempt-chain',
	'no-session-rules',
	'no-d13',
	'no-ledger',
	'no-command-log',
	'no-sha256',
	'no-git-history',
	'no-streak',
];
const off = (name) => MUTATE === name;

// Known evidence overwrites. Each entry names one evidence file (root and path below it) and the exact git blob ids
// before and after the one commit that rewrote it, so only that rewrite is accepted: any other change to the same
// file, or the same change to another file, is still evidence-overwritten. An entry is added only on the user's
// decision, never to clear a finding of a run's own legs.
const KNOWN_OVERWRITES = Object.freeze([
	// 64-53, 2026-10-15: the orchestrator had the clockRule line rewritten to the user's CLOCK-SKEW-OVERRIDE
	// (10000 ms per device and per pair) in .planning 7423dae3; the user chose this one-off exception.
	Object.freeze({
		root: '64-device-evidence',
		rel: 'rehearsal-2026-10-14/run-1/attempt-2/reassert/leg.md',
		before: 'ad65ed6fbfda163bc50c0dc67326964d16f3caf4',
		after: 'b1ab285f392e6389c1a209c1629f6f8d419116ae',
	}),
]);
let selftestKnown = [];
const blobId = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const knownOverwrite = (root, rel, before, after) =>
	[...KNOWN_OVERWRITES, ...selftestKnown].some(
		(k) => k.root === root && k.rel === rel && k.before === blobId(before) && k.after === blobId(after),
	);

const ROOTS = { '64-evidence': 'H', '64-device-evidence': 'D' };
const SESSION_RE = /^(rehearsal|hardware)-\d{4}-\d{2}-\d{2}(-[a-z0-9]+)?$/;
const D13 =
	"hardware runs cover 'member joins a network founded before it was a member' only; 'Authority founds while members are connected' is covered by L1 on the host, with MemoryRawStorage";
const WALL_LINE1 = ['VERDICT: CLEAN', 'VERDICT: HIT (stop, ask user)', 'VERDICT: PENDING'];
const VERDICT_RE = /^VERDICT: (PASS|(FAIL|VOID) [a-z0-9][a-z0-9-]*)$/;
const RUN_RE = /^RUN: (PASS|(FAIL|STOP) [a-z0-9][a-z0-9-]*)$/;
const FORBIDDEN_EXT = new Set(
	(
		'png jpg jpeg gif webp heic heif bmp tif tiff svg mp4 mov webm m4a wav xml plist hprof cpuprofile ' +
		'apk aab ipa zip tar gz tgz 7z jks keystore p12 pfx key pem der cer crt mobileprovision sqlite db ldb'
	).split(' '),
);

// ---------- pattern fragments ----------
const JOIN = ['vt', 'join'].join('');
const INVITE = 'sereus' + '-invite:';
const IPRIV = 'invite' + 'Private';
const PROBE_ID = 'association-capture' + '-probe/';
const B64U = '[A-Za-z0-9_-]';
const CLS = '[A-Za-z0-9+/=_.-]';
const CLSN = '[A-Za-z0-9+/=_.:-]';
const Q = '["\'`]';
const SEP = `${Q}?\\s*[:=]\\s*${Q}?`;
const SEP_BARE = `${Q}?\\s*[:=]\\s*`;
const key = (names) => `(?<![A-Za-z0-9_])(?:${names.join('|')})(?![A-Za-z0-9_])`;
const dev = (s) => 'device' + s;
const non = (s) => 'non' + s;
const ID_VAL = `(?=${CLS}*[0-9])${CLS}{13,}`;
const NONCE_VAL = `(?=${CLSN}*[0-9])${CLSN}{13,}`;
const ATT_VAL = `(?:\\[\\s*${Q}|${Q}\\{|${Q}[A-Za-z0-9+/=_-]{24,})`;
const MARKUP_NAMES = '/?(content|invoke|antml|parameter|function_calls)';

const RULES = {
	'secret-vtjoin1': new RegExp(`${JOIN}1\\.${B64U}{8,}`),
	'secret-vtjoin2': new RegExp(`${JOIN}(?:[02-9][0-9]*|1[0-9]+)\\.${B64U}{8,}`),
	'secret-sereus-invite': new RegExp(`${INVITE.replace('-', '\\-')}[0-9]+\\.${B64U}{8,}`),
	'secret-invite-private': new RegExp(`${key([IPRIV, IPRIV + 'Key', 'issuer' + 'Sig'])}${SEP}${`(?=${CLS}*[0-9])${CLS}{16,}`}`),
	'secret-raw-chain': new RegExp(
		`MII[A-Za-z0-9+/]{150,}|${'-----' + 'BEGIN '}(?:[A-Z]+ )?(?:CERTIFICATE|PRIVATE KEY|PUBLIC KEY)${'-----'}|(?<![0-9A-Za-z])${'30' + '82'}[0-9a-fA-F]{300,}`,
	),
	'secret-image-data': new RegExp(`${'data:' + 'image/'}[A-Za-z0-9.+-]+;base64,`),
	'secret-vote-needle': /(?<![a-z0-9])[a-z0-9]+-needle-[a-z0-9]{4,}/,
};
const ID_D = new RegExp(
	`${key([dev('Id'), 'De' + 'viceId', dev('_id'), 'DEVICE' + '_ID'])}${SEP}${ID_VAL}|${key([dev('IdPrefix')])}${SEP}${CLS}{9,}`,
);
const ID_H = new RegExp(`${key(['De' + 'viceId'])}${SEP}${ID_VAL}`);
const NONCE_D = new RegExp(`${key([non('ce'), 'No' + 'nce', 'NON' + 'CE', 'challenge' + 'Nonce'])}${SEP}${NONCE_VAL}`);
const NONCE_H = new RegExp(`${key(['No' + 'nce'])}${SEP}${NONCE_VAL}`);
const ATT_NAMES_D = [
	'certificate' + 'Chain',
	dev('KeyCertificateChain'),
	'attestation' + 'Statement',
	'Attestation' + 'Details',
	'attestation' + 'Object',
	'pop' + 'Signature',
	'asser' + 'tion',
	'safetyNet' + 'Attestation',
	'appAttest' + 'KeyId',
];
const ATT_D = new RegExp(`${key(ATT_NAMES_D)}${SEP_BARE}${ATT_VAL}`);
const ATT_H = new RegExp(`${key(['Attestation' + 'Details'])}${SEP_BARE}${ATT_VAL}`);
const MARKUP = new RegExp('<' + MARKUP_NAMES);
const PM_CLEAR = new RegExp('\\bpm' + '\\s+' + 'clear\\b');
const CMD_CLEAR = new RegExp('\\bcmd' + '\\s+package' + '\\s+clear\\b');
const PGREP_E = new RegExp('\\bpgrep' + '(?:\\s+-[A-Za-z]+)*' + '\\s+-[A-Za-z]*E[A-Za-z]*\\b');
const CAPTURE_PROBE = new RegExp(PROBE_ID.replace('/', '\\/'));
const ROWS_KEY = /["']?rows["']?\s*:\s*\[/;

// ---------- helpers ----------
const posix = (p) => p.split(sep).join('/');
const lineOf = (text, idx) => {
	let n = 1;
	for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++;
	return n;
};
const sha12 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
const firstLine = (abs) => {
	try {
		const t = readFileSync(abs, 'utf8');
		const i = t.indexOf('\n');
		return i === -1 ? t : t.slice(0, i);
	} catch {
		return null;
	}
};
const collapse = (s) => s.replace(/\s+/g, ' ');
const hasD13 = (text) => collapse(text).includes(collapse(D13));
const isTextRuleFile = (name) => !name.endsWith('.md') && !name.endsWith('.json');

function makeFinding(token, path, line, detail) {
	return { token, path, line, detail };
}
function fmt(f) {
	return `FAIL ${f.token} ${f.path}${f.line ? ` line ${f.line}` : ''}${f.detail ? ` ${f.detail}` : ''}`;
}

class Err extends Error {
	constructor(token) {
		super(token);
		this.token = token;
	}
}

// ---------- text rules ----------
function firstMatch(re, text) {
	const m = re.exec(text);
	return m ? lineOf(text, m.index) : 0;
}

/** Secret-family rules for one file. Returns one finding per token. */
function secretRules(zone, rel, text, known) {
	if (off('no-secret-grep')) return [];
	const out = [];
	const add = (token, line, detail) => out.push(makeFinding(token, rel, line, detail));
	for (const [token, re] of Object.entries(RULES)) {
		if (token === 'secret-vote-needle' && !text.includes('-needle-')) continue;
		const line = firstMatch(re, text);
		if (line) add(token, line);
	}
	const sets = zone === 'D' ? [ID_D, NONCE_D, ATT_D] : [ID_H, NONCE_H, ATT_H];
	const names = ['secret-device-id', 'secret-nonce', 'secret-attestation-field'];
	sets.forEach((re, i) => {
		const line = firstMatch(re, text);
		if (line) add(names[i], line);
	});
	if (CAPTURE_PROBE.test(text) && ROWS_KEY.test(text)) add('raw-capture-file', firstMatch(ROWS_KEY, text));
	if (known) {
		const hit = knownHit(known, text);
		if (hit) add('secret-known-value', hit.line, `secret #${hit.index}`);
	}
	return out;
}

function markupRules(rel, text) {
	if (off('no-markup-grep')) return [];
	const line = firstMatch(MARKUP, text);
	return line ? [makeFinding('markup-leak', rel, line)] : [];
}

function commandRules(rel, text) {
	if (off('no-command-log')) return [];
	const out = [];
	const a = firstMatch(PM_CLEAR, text) || firstMatch(CMD_CLEAR, text);
	if (a) out.push(makeFinding('pm-clear', rel, a));
	const b = firstMatch(PGREP_E, text);
	if (b) out.push(makeFinding('pgrep-dash-e', rel, b));
	return out;
}

/** Every text rule over one file's text (used by the walker and by the self-trip pass). */
function textRules(zone, rel, name, text, known) {
	return [...secretRules(zone, rel, text, known), ...markupRules(rel, text), ...(isTextRuleFile(name) ? commandRules(rel, text) : [])];
}

// ---------- known secrets ----------
function loadKnown(file) {
	const lines = readFileSync(file, 'utf8')
		.split('\n')
		.map((l) => l.replace(/\r$/, ''));
	const windows = new Map();
	const short = [];
	lines.forEach((s, index) => {
		if (s.length >= 16) {
			for (let i = 0; i + 16 <= s.length; i++) if (!windows.has(s.slice(i, i + 16))) windows.set(s.slice(i, i + 16), index);
		} else if (s.length >= 4) short.push([s, index]);
	});
	return { windows, short };
}
function knownHit(known, text) {
	for (let i = 0; i + 16 <= text.length; i++) {
		const idx = known.windows.get(text.slice(i, i + 16));
		if (idx !== undefined) return { index: idx, line: lineOf(text, i) };
	}
	for (const [s, index] of known.short) {
		const at = text.indexOf(s);
		if (at !== -1) return { index, line: lineOf(text, at) };
	}
	return null;
}

// ---------- walker ----------
function walk(rootAbs, rootName) {
	const files = [];
	const dirs = new Map();
	const links = [];
	let ignored = 0;
	const visit = (abs, rel) => {
		const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		const node = { subdirs: [], files: [] };
		dirs.set(rel, node);
		for (const e of entries) {
			const childAbs = join(abs, e.name);
			const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
			const st = lstatSync(childAbs);
			if (st.isSymbolicLink()) {
				const target = readlinkSync(childAbs);
				const allowed = e.name === 'node_modules' && target.endsWith('packages/vote-engine/node_modules');
				if (!allowed) links.push(childRel);
				continue;
			}
			if (st.isDirectory()) {
				if (e.name === '.git') {
					ignored++;
					continue;
				}
				node.subdirs.push(e.name);
				visit(childAbs, childRel);
			} else if (st.isFile()) {
				if (e.name === '.DS_Store') {
					ignored++;
					continue;
				}
				node.files.push(e.name);
				files.push({ abs: childAbs, rel: childRel, name: e.name });
			}
		}
	};
	visit(rootAbs, '');
	return { rootAbs, rootName, files, dirs, links, ignored };
}

// ---------- attempt chains ----------
const numbered = (names, prefix) => {
	const re = new RegExp(`^${prefix}-([0-9]+)$`);
	return names.filter((n) => re.test(n)).map((n) => ({ name: n, digits: re.exec(n)[1] }));
};
function numberingOk(items) {
	if (items.some((i) => String(Number(i.digits)) !== i.digits)) return false;
	const nums = items.map((i) => Number(i.digits)).sort((a, b) => a - b);
	return nums.every((n, i) => n === i + 1);
}
const subs = (tree, rel) => tree.dirs.get(rel)?.subdirs ?? [];
const filesIn = (tree, rel) => tree.dirs.get(rel)?.files ?? [];
const join2 = (a, b) => (a === '' ? b : `${a}/${b}`);
const legsOf = (tree, attemptRel) => {
	const s = subs(tree, attemptRel);
	return s.length ? s.map((x) => join2(attemptRel, x)) : [attemptRel];
};
const verdictLine = (tree, legRel) => (filesIn(tree, legRel).includes('verdict.txt') ? firstLine(join(tree.rootAbs, legRel, 'verdict.txt')) : null);
const isNonPass = (line) => line !== null && /^VERDICT: (FAIL|VOID)/.test(line);
function allFiles(tree, rel, out = []) {
	for (const f of filesIn(tree, rel)) out.push(f);
	for (const s of subs(tree, rel)) allFiles(tree, join2(rel, s), out);
	return out;
}
function oneLine(abs) {
	let t;
	try {
		t = readFileSync(abs, 'utf8');
	} catch {
		return false;
	}
	const lines = t.replace(/\n$/, '').split('\n');
	return lines.length === 1 && lines[0].trim() !== '';
}

/**
 * E86 (64-65, notes 19 E86): after the user-ordered full rig wipe, a session's network-n7 holds exactly attempt-1 to attempt-4
 * and attempt-4/reason.txt is one line "RESTART notes-19-e86: ..."; then attempt-4 may follow attempt-3's PASS (the n7 that
 * attempt-3 founded no longer exists on any rig device). The same holds for the Redmi keyholder part: network-n7-kh2r holds exactly
 * attempt-1 and attempt-2, and attempt-2/reason.txt is one "RESTART notes-19-e86: ..." line (attempt-1 joined the wiped n7). Every
 * other rule still applies; nothing else is accepted.
 */
const E86_RESTART_SHAPES = { 'network-n7': { n: 4, chain: '1,2,3,4' }, 'network-n7-kh2r': { n: 2, chain: '1,2' } };
function declaredNetworkRestart(tree, rel, sorted, a) {
	const shape = Object.hasOwn(E86_RESTART_SHAPES, basename(rel)) ? E86_RESTART_SHAPES[basename(rel)] : null;
	if (!shape || !SESSION_RE.test(basename(dirname(rel)))) return false;
	if (a.n !== shape.n || sorted.map((x) => x.n).join(',') !== shape.chain) return false;
	const r = join2(a.rel, 'reason.txt');
	if (!filesIn(tree, a.rel).includes('reason.txt') || !oneLine(join(tree.rootAbs, r))) return false;
	return RESTART_E86_RE.test(firstLine(join(tree.rootAbs, r)) ?? '');
}
function chainRules(tree, zone) {
	if (off('no-attempt-chain')) return [];
	const out = [];
	const path = (rel) => (rel === '' ? tree.rootName : `${tree.rootName}/${rel}`);
	for (const [rel, node] of tree.dirs) {
		const attempts = numbered(node.subdirs, 'attempt');
		const isRun = zone === 'D' && /^run-[0-9]+$/.test(basename(rel)) && SESSION_RE.test(basename(dirname(rel)));
		if (isRun || attempts.length) {
			if (attempts.length && !numberingOk(attempts)) {
				out.push(makeFinding('numbering-gap', path(rel)));
				continue;
			}
		}
		if (!attempts.length) continue;
		const sorted = attempts.map((a) => ({ n: Number(a.digits), rel: join2(rel, a.name) })).sort((a, b) => a.n - b.n);
		const tracked =
			isRun ||
			sorted.some((a) => {
				if (filesIn(tree, a.rel).includes('verdict.txt')) return true;
				return subs(tree, a.rel).some((s) => filesIn(tree, join2(a.rel, s)).includes('verdict.txt'));
			});
		for (const a of sorted) {
			const legs = legsOf(tree, a.rel);
			if (tracked) {
				for (const leg of legs) {
					const v = verdictLine(tree, leg);
					if (v === null) out.push(makeFinding('attempt-no-verdict', path(leg)));
					else if (isNonPass(v)) {
						const logs = allFiles(tree, leg).filter((f) => f !== 'verdict.txt' && f !== 'reason.txt');
						if (!logs.length) out.push(makeFinding('failure-without-log', path(leg)));
					}
				}
				if (a.n >= 2) {
					const prev = sorted.find((x) => x.n === a.n - 1);
					const prevFail = prev && legsOf(tree, prev.rel).some((leg) => isNonPass(verdictLine(tree, leg)));
					if (!prevFail && !declaredNetworkRestart(tree, rel, sorted, a)) out.push(makeFinding('retry-without-failure', path(a.rel)));
				}
			}
			if (a.n >= 2) {
				const reasons = [join2(a.rel, 'reason.txt'), ...subs(tree, a.rel).map((s) => join2(join2(a.rel, s), 'reason.txt'))];
				const present = reasons.filter((r) => filesIn(tree, dirname(r)).includes('reason.txt'));
				const bad = present.filter((r) => !oneLine(join(tree.rootAbs, r)));
				if (!present.length || bad.length) out.push(makeFinding('reason-missing', path(a.rel)));
			}
		}
	}
	for (const f of tree.files) {
		if (f.name !== 'verdict.txt') continue;
		const l = firstLine(f.abs);
		if (l === null || !VERDICT_RE.test(l)) out.push(makeFinding('verdict-malformed', path(f.rel), 1));
	}
	return out;
}

// ---------- sessions ----------
function sessionDirs(tree) {
	return [...tree.dirs.keys()].filter((rel) => rel !== '' && SESSION_RE.test(basename(rel)));
}
function sessionRules(tree) {
	const out = [];
	const path = (rel) => `${tree.rootName}/${rel}`;
	for (const s of sessionDirs(tree)) {
		const runs = numbered(subs(tree, s), 'run');
		if (!off('no-attempt-chain') && runs.length && !numberingOk(runs)) out.push(makeFinding('numbering-gap', path(s)));
		const failuresText = [];
		for (const f of tree.files) {
			if (f.rel.slice(0, s.length + 10) === `${s}/failures/`) failuresText.push(readFileSync(f.abs, 'utf8'));
		}
		const blob = failuresText.join('\n');
		for (const r of runs) {
			const runRel = join2(s, r.name);
			if (!off('no-session-rules')) {
				const sum = filesIn(tree, runRel).includes('summary.md') ? firstLine(join(tree.rootAbs, runRel, 'summary.md')) : null;
				if (sum === null || !RUN_RE.test(sum)) out.push(makeFinding('run-summary-invalid', path(runRel), 1));
				for (const a of numbered(subs(tree, runRel), 'attempt')) {
					const aRel = join2(runRel, a.name);
					if (legsOf(tree, aRel).some((leg) => isNonPass(verdictLine(tree, leg))) && !blob.includes(`${r.name}/${a.name}`)) {
						out.push(makeFinding('failure-not-indexed', path(aRel)));
					}
				}
			}
		}
		if (!off('no-d13')) {
			const sm = join(tree.rootAbs, s, 'session.md');
			if (!existsSync(sm) || !hasD13(readFileSync(sm, 'utf8'))) out.push(makeFinding('d13-missing-session', path(s)));
		}
	}
	return out;
}

// ---------- gate files, ledger, sums ----------
function gateRules(tree) {
	if (off('no-d13')) return [];
	const out = [];
	if (tree.rootName === '64-evidence') {
		const wg = join(dirname(tree.rootAbs), '64-WALL-GATE.md');
		const wgName = '64-WALL-GATE.md';
		if (!existsSync(wg) || !hasD13(readFileSync(wg, 'utf8'))) out.push(makeFinding('d13-missing-wall-gate', wgName));
		if (existsSync(wg)) {
			const text = readFileSync(wg, 'utf8');
			const l1 = text.split('\n')[0];
			if (!WALL_LINE1.includes(l1) || text.split('VERDICT:').length - 1 !== 1) out.push(makeFinding('wall-gate-line1-invalid', wgName, 1));
		}
	} else {
		const es = join(tree.rootAbs, 'EVIDENCE-SUMMARY.md');
		if (existsSync(es) && !hasD13(readFileSync(es, 'utf8'))) out.push(makeFinding('d13-missing-summary', `${tree.rootName}/EVIDENCE-SUMMARY.md`));
	}
	return out;
}

function ledgerRules(tree) {
	if (off('no-ledger') || tree.rootName !== '64-evidence') return [];
	const f = join(tree.rootAbs, 'session.md');
	if (!existsSync(f)) return [];
	const lines = readFileSync(f, 'utf8').split('\n');
	const out = [];
	lines.forEach((l, i) => {
		const m = /^START ([0-9]+) (\S+) (\S+) /.exec(l);
		if (!m) return;
		const [, n, , label] = m;
		const closed = lines.slice(i + 1).some((x) => x.slice(0, 4 + n.length + 1) === `END ${n} ` || (x.slice(0, 11) === 'INTERRUPTED' && (x.includes(` ${n} `) || x.includes(label))));
		if (!closed) out.push(makeFinding('ledger-unclosed', `${tree.rootName}/session.md`, i + 1, `n=${n}`));
	});
	return out;
}

function sumRules(tree) {
	if (off('no-sha256')) return [];
	const out = [];
	for (const f of tree.files) {
		if (f.name !== 'SHA256SUMS') continue;
		const dir = dirname(f.abs);
		readFileSync(f.abs, 'utf8')
			.split('\n')
			.forEach((l, i) => {
				if (l.trim() === '') return;
				const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l);
				const target = m ? join(dir, m[2]) : null;
				let ok = false;
				if (m && existsSync(target) && lstatSync(target).isFile()) ok = createHash('sha256').update(readFileSync(target)).digest('hex') === m[1];
				if (!ok) out.push(makeFinding('sha256-mismatch', `${tree.rootName}/${f.rel}`, i + 1));
			});
	}
	return out;
}

function fileRules(tree) {
	if (off('no-file-rules')) return [];
	const out = [];
	for (const f of tree.files) {
		const dot = f.name.lastIndexOf('.');
		if (dot > 0 && FORBIDDEN_EXT.has(f.name.slice(dot + 1).toLowerCase())) out.push(makeFinding('forbidden-file-type', `${tree.rootName}/${f.rel}`));
	}
	for (const l of tree.links) out.push(makeFinding('symlink-in-evidence', `${tree.rootName}/${l}`));
	return out;
}

// ---------- git history ----------
function git(top, args, asBuffer) {
	return execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-C', top, ...args], {
		encoding: asBuffer ? 'buffer' : 'utf8',
		maxBuffer: 1 << 28,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}
function repoTop(dir) {
	try {
		return realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim());
	} catch {
		return null;
	}
}
const inScope = (relToTop) => {
	const segs = relToTop.split('/');
	const name = segs[segs.length - 1];
	return segs.some((s) => /^attempt-[0-9]+$/.test(s)) || name.endsWith('.log') || name.slice(0, 7) === 'logcat-' || name === 'verdict.txt';
};
const isPrefix = (oldBuf, newBuf) => newBuf.length >= oldBuf.length && Buffer.compare(newBuf.subarray(0, oldBuf.length), oldBuf) === 0;
function gitRules(tree, top) {
	if (off('no-git-history')) return [];
	const out = [];
	const seen = new Set();
	const add = (token, rel, detail) => {
		const k = `${token} ${rel}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push(makeFinding(token, `${tree.rootName}/${posix(relative(tree.rootAbs, join(top, rel)))}`, 0, detail));
	};
	const relRoot = posix(relative(top, tree.rootAbs)) || '.';
	let current = null;
	for (const l of git(top, ['log', '--no-renames', '--format=C%x20%H', '--name-status', '--', relRoot]).split('\n')) {
		const c = /^C ([0-9a-f]{40})$/.exec(l);
		if (c) {
			current = c[1];
			continue;
		}
		const m = /^([A-Z])\t(.+)$/.exec(l);
		if (!m || !current || !inScope(m[2])) continue;
		if (m[1] === 'D') add('evidence-deleted', m[2], `commit ${current.slice(0, 12)}`);
		else if (m[1] === 'M') {
			let before;
			let after;
			try {
				before = git(top, ['show', `${current}^:${m[2]}`], true);
				after = git(top, ['show', `${current}:${m[2]}`], true);
			} catch {
				continue;
			}
			if (!isPrefix(before, after) && !knownOverwrite(tree.rootName, posix(relative(tree.rootAbs, join(top, m[2]))), before, after))
				add('evidence-overwritten', m[2], `commit ${current.slice(0, 12)}`);
		}
	}
	const st = git(top, ['status', '--porcelain=v1', '-z', '--no-renames', '--', relRoot]).split('\0').filter(Boolean);
	for (const e of st) {
		const x = e[0];
		const y = e[1];
		const p = e.slice(3);
		if (!inScope(p)) continue;
		if (x === 'D' || y === 'D') add('evidence-deleted', p, 'uncommitted');
		else if (x === 'M' || y === 'M') {
			try {
				const before = git(top, ['show', `HEAD:${p}`], true);
				if (!isPrefix(before, readFileSync(join(top, p)))) add('evidence-overwritten', p, 'uncommitted');
			} catch {
				// no committed blob to compare
			}
		}
	}
	return out;
}

// ---------- streak ----------
const RESTART_RE = new RegExp('^RESTART notes-19-e7: .+$');
const RESTART_E12_RE = new RegExp('^RESTART notes-19-e12: .+$');
const RESTART_E15_RE = new RegExp('^RESTART notes-19-e15: .+$');
const RESTART_E23_RE = new RegExp('^RESTART notes-19-e23: .+$');
const RESTART_E77_RE = new RegExp('^RESTART notes-19-e77: .+$');
const RESTART_E81_RE = new RegExp('^RESTART notes-19-e81: .+$');
const RESTART_E83_RE = new RegExp('^RESTART notes-19-e83: .+$');
const RESTART_E84_RE = new RegExp('^RESTART notes-19-e84: .+$');
const RESTART_E85_RE = new RegExp('^RESTART notes-19-e85: .+$');
const RESTART_E86_RE = new RegExp('^RESTART notes-19-e86: .+$');
/** attempt/reason.txt is exactly one line matching re. */
function restartLine(rdir, attempt, re) {
	let text;
	try {
		text = readFileSync(join(rdir, attempt, 'reason.txt'), 'utf8');
	} catch {
		return false;
	}
	const lines = text.replace(/\n$/, '').split('\n');
	return lines.length === 1 && re.test(lines[0]);
}
/** The attempt holds at least one leg whose verdict line 1 is not VERDICT: PASS (a leg-less attempt reads its own verdict). */
function attemptHasNonPass(rdir, attempt) {
	const a = join(rdir, attempt);
	const legDirs = readdirSync(a, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	const legs = legDirs.length ? legDirs : [''];
	return legs.some((l) => firstLine(join(a, l, 'verdict.txt')) !== 'VERDICT: PASS');
}
/**
 * True only for the declared restart chains (see the header). attempts is the sorted list of attempt dirs.
 * E7: run-1, attempts exactly attempt-1 and attempt-2, attempt-2 reason "RESTART notes-19-e7: ...", attempt-1 non-PASS.
 * E12 (64-55): run-1, attempts exactly attempt-1..attempt-3, attempt-2 reason e7, attempt-3 reason
 * "RESTART notes-19-e12: ...", attempt-1 and attempt-2 each non-PASS.
 * E15 (64-56): run-1, attempts exactly attempt-1..attempt-4, attempt-2 reason e7, attempt-3 reason e12, attempt-4 reason
 * "RESTART notes-19-e15: ...", attempts 1, 2 and 3 each non-PASS.
 * E23 (64-60): the E15 chain with attempt-4 reason "RESTART notes-19-e23: ..." (E15 or E23, never both, one line); no
 * five-attempt branch for e23 itself.
 * E77 (64-57, notes 19 E77): the E15 or E23 chain plus attempt-5 reason "RESTART notes-19-e77: ..." (one line), attempts
 * 1 to 4 each non-PASS.
 * E81 (64-57, notes 19 E81): the E77 chain plus attempt-6 reason "RESTART notes-19-e81: ..." (one line), attempts 1 to 5
 * each non-PASS.
 * E83 (64-57, notes 19 E83): the E81 chain plus attempt-7 reason "RESTART notes-19-e83: ..." (one line), attempts 1 to 6
 * each non-PASS.
 * E84 (64-57, notes 19 E84): the E83 chain plus attempt-8 reason "RESTART notes-19-e84: ..." (one line), attempts 1 to 7
 * each non-PASS.
 * E85 (64-57, notes 19 E85): the E84 chain plus attempt-9 reason "RESTART notes-19-e85: ..." (one line), attempts 1 to 8
 * each non-PASS.
 * E86 (64-57, notes 19 E86): the E85 chain plus attempt-10 reason "RESTART notes-19-e86: ..." (one line), attempts 1 to 9
 * each non-PASS. Nothing else is accepted.
 */
function declaredRestart(rdir, attempts) {
	if (basename(rdir) !== 'run-1') return false;
	const names = attempts.map((a) => a.name).join(',');
	if (names === 'attempt-1,attempt-2') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		return attemptHasNonPass(rdir, 'attempt-1');
	}
	if (names === 'attempt-1,attempt-2,attempt-3') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		return attemptHasNonPass(rdir, 'attempt-1') && attemptHasNonPass(rdir, 'attempt-2');
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		return attemptHasNonPass(rdir, 'attempt-1') && attemptHasNonPass(rdir, 'attempt-2') && attemptHasNonPass(rdir, 'attempt-3');
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4'].every((a) => attemptHasNonPass(rdir, a));
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5,attempt-6') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		if (!restartLine(rdir, 'attempt-6', RESTART_E81_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4', 'attempt-5'].every((a) => attemptHasNonPass(rdir, a));
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5,attempt-6,attempt-7') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		if (!restartLine(rdir, 'attempt-6', RESTART_E81_RE)) return false;
		if (!restartLine(rdir, 'attempt-7', RESTART_E83_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4', 'attempt-5', 'attempt-6'].every((a) => attemptHasNonPass(rdir, a));
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5,attempt-6,attempt-7,attempt-8') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		if (!restartLine(rdir, 'attempt-6', RESTART_E81_RE)) return false;
		if (!restartLine(rdir, 'attempt-7', RESTART_E83_RE)) return false;
		if (!restartLine(rdir, 'attempt-8', RESTART_E84_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4', 'attempt-5', 'attempt-6', 'attempt-7'].every((a) => attemptHasNonPass(rdir, a));
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5,attempt-6,attempt-7,attempt-8,attempt-9') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		if (!restartLine(rdir, 'attempt-6', RESTART_E81_RE)) return false;
		if (!restartLine(rdir, 'attempt-7', RESTART_E83_RE)) return false;
		if (!restartLine(rdir, 'attempt-8', RESTART_E84_RE)) return false;
		if (!restartLine(rdir, 'attempt-9', RESTART_E85_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4', 'attempt-5', 'attempt-6', 'attempt-7', 'attempt-8'].every((a) => attemptHasNonPass(rdir, a));
	}
	if (names === 'attempt-1,attempt-2,attempt-3,attempt-4,attempt-5,attempt-6,attempt-7,attempt-8,attempt-9,attempt-10') {
		if (!restartLine(rdir, 'attempt-2', RESTART_RE)) return false;
		if (!restartLine(rdir, 'attempt-3', RESTART_E12_RE)) return false;
		if (!restartLine(rdir, 'attempt-4', RESTART_E15_RE) && !restartLine(rdir, 'attempt-4', RESTART_E23_RE)) return false;
		if (!restartLine(rdir, 'attempt-5', RESTART_E77_RE)) return false;
		if (!restartLine(rdir, 'attempt-6', RESTART_E81_RE)) return false;
		if (!restartLine(rdir, 'attempt-7', RESTART_E83_RE)) return false;
		if (!restartLine(rdir, 'attempt-8', RESTART_E84_RE)) return false;
		if (!restartLine(rdir, 'attempt-9', RESTART_E85_RE)) return false;
		if (!restartLine(rdir, 'attempt-10', RESTART_E86_RE)) return false;
		return ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4', 'attempt-5', 'attempt-6', 'attempt-7', 'attempt-8', 'attempt-9'].every((a) => attemptHasNonPass(rdir, a));
	}
	return false;
}
function streakRules(opts, trees) {
	const out = [];
	let session = opts.session;
	if (!session) {
		const dTree = trees.find((t) => t.rootName === '64-device-evidence');
		const cands = dTree ? subs(dTree, '').filter((n) => /^rehearsal-/.test(n)) : [];
		if (cands.length !== 1) throw new Err('streak-session-ambiguous');
		session = join(dTree.rootAbs, cands[0]);
	}
	const name = basename(session);
	const parent = trees.find((t) => session.slice(0, t.rootAbs.length + 1) === t.rootAbs + sep);
	const show = parent ? `${parent.rootName}/${posix(relative(parent.rootAbs, session))}` : name;
	const list = (dir, prefix) =>
		readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && new RegExp(`^${prefix}-[0-9]+$`).test(e.name))
			.map((e) => ({ name: e.name, n: Number(e.name.split('-')[1]) }))
			.sort((a, b) => a.n - b.n);
	const runs = list(session, 'run');
	const K = opts.streak;
	const lines = [];
	const bad = [];
	if (off('no-streak')) {
		lines.push(`STREAK PASS k=${K} session=${name} runs=none`);
		return { findings: out, lines };
	}
	if (runs.length < K) bad.push(makeFinding('streak-short', show, 0, `runs=${runs.length}`));
	else {
		for (const r of runs.slice(-K)) {
			const rdir = join(session, r.name);
			const attempts = list(rdir, 'attempt');
			if (!declaredRestart(rdir, attempts) && attempts.some((a) => a.name !== 'attempt-1')) bad.push(makeFinding('streak-retried', `${show}/${r.name}`));
			const top = attempts[attempts.length - 1];
			let notPass = !top;
			if (top) {
				const adir = join(rdir, top.name);
				const legDirs = readdirSync(adir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
				const legs = legDirs.length ? legDirs : [''];
				for (const l of legs) if (firstLine(join(adir, l, 'verdict.txt')) !== 'VERDICT: PASS') notPass = true;
				for (const want of opts.legs) if (!legDirs.includes(want)) notPass = true;
			}
			if (firstLine(join(rdir, 'summary.md')) !== 'RUN: PASS') notPass = true;
			if (notPass) bad.push(makeFinding('streak-not-pass', `${show}/${r.name}`));
		}
	}
	const last = runs.slice(-K);
	const range = last.length ? `${last[0].n}-${last[last.length - 1].n}` : 'none';
	lines.push(bad.length ? `STREAK FAIL k=${K} session=${name} runs=${range}` : `STREAK PASS k=${K} session=${name} runs=${range}`);
	return { findings: bad, lines };
}

// ---------- the checker ----------
function parseArgs(argv, allowSelftest) {
	const o = { git: false, secrets: null, streak: 0, session: null, legs: [], paths: [], selftest: false };
	let secretsSeen = 0;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Err('usage');
			return argv[++i];
		};
		if (a === '--git') o.git = true;
		else if (a === '--secrets-file') {
			secretsSeen++;
			o.secrets = next();
		} else if (a === '--streak') {
			o.streak = Number(next());
			if (!Number.isInteger(o.streak) || o.streak < 1) throw new Err('usage');
		} else if (a === '--session') o.session = next();
		else if (a === '--legs') o.legs = next().split(',').filter(Boolean);
		else if (a === '--selftest' && allowSelftest) o.selftest = true;
		else if (a.slice(0, 2) === '--') throw new Err('usage');
		else o.paths.push(a);
	}
	if (secretsSeen > 1) throw new Err('usage');
	if ((o.session || o.legs.length) && !o.streak) throw new Err('usage');
	if (!o.selftest && !o.paths.length) throw new Err('usage');
	return o;
}

function resolveRoots(paths) {
	const roots = [];
	for (const p of paths) {
		let real;
		try {
			real = realpathSync(p);
		} catch {
			throw new Err('root-missing');
		}
		if (ROOTS[basename(real)]) roots.push(real);
		else {
			const inner = Object.keys(ROOTS)
				.map((n) => join(real, n))
				.filter((d) => existsSync(d) && lstatSync(d).isDirectory());
			if (!inner.length) throw new Err('not-an-evidence-root');
			roots.push(...inner.map((d) => realpathSync(d)));
		}
	}
	return [...new Set(roots)];
}

export function runChecker(argv) {
	const lines = [];
	try {
		const o = parseArgs(argv, false);
		const roots = resolveRoots(o.paths);
		let known = null;
		if (o.secrets) {
			let real;
			try {
				real = realpathSync(o.secrets);
				readFileSync(real);
			} catch {
				throw new Err('secrets-file-unreadable');
			}
			const tops = [realpathSync(REPO), ...roots.map((r) => repoTop(r))].filter(Boolean);
			if (tops.some((t) => real === t || real.slice(0, t.length + 1) === t + sep)) throw new Err('secrets-file-inside-repo');
			known = loadKnown(real);
		}
		const findings = [];
		const trees = [];
		let files = 0;
		let dirs = 0;
		let ignored = 0;
		for (const r of roots) {
			const rootName = basename(r);
			const zone = ROOTS[rootName];
			const tree = walk(r, rootName);
			trees.push(tree);
			files += tree.files.length;
			dirs += tree.dirs.size - 1;
			ignored += tree.ignored;
			for (const f of tree.files) {
				const rel = `${rootName}/${f.rel}`;
				const dot = f.name.lastIndexOf('.');
				if (dot > 0 && FORBIDDEN_EXT.has(f.name.slice(dot + 1).toLowerCase()) && !off('no-file-rules')) continue;
				findings.push(...textRules(zone, rel, f.name, readFileSync(f.abs, 'utf8'), known));
			}
			findings.push(...fileRules(tree), ...chainRules(tree, zone), ...(zone === 'D' ? sessionRules(tree) : []), ...gateRules(tree), ...ledgerRules(tree), ...sumRules(tree));
			if (o.git) {
				const top = repoTop(r);
				if (!top) throw new Err('git-unavailable');
				findings.push(...gitRules(tree, top));
			}
		}
		if (o.streak) {
			const s = streakRules(o, trees);
			findings.push(...s.findings);
			lines.push(...s.lines);
		}
		const seen = new Set();
		const uniq = findings.filter((f) => {
			const k = `${f.token}|${f.path}|${f.line}|${f.detail}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const body = uniq.map(fmt);
		const streakLines = lines.splice(0);
		lines.push(...body, ...streakLines);
		if (uniq.length) {
			const tokens = [...new Set(uniq.map((f) => f.token))].sort();
			lines.push(`EVIDENCE FAIL findings=${uniq.length} tokens=${tokens.join(',')}`);
			return { exitCode: 1, lines, tokens };
		}
		lines.push(`EVIDENCE PASS roots=${roots.length} files=${files} dirs=${dirs} ignored=${ignored}`);
		return { exitCode: 0, lines, tokens: [] };
	} catch (e) {
		if (e instanceof Err) return { exitCode: 2, lines: [`ERROR ${e.token}`], tokens: [] };
		throw e;
	}
}

// ---------- selftest ----------
const PLANTS = {
	vtjoin1: () => `${JOIN}1.SYNTHETICxPLANTx0001`,
	vtjoin2: () => `${JOIN}2.SYNTHETICxPLANTx0002`,
	'sereus-invite': () => `${INVITE}1.SYNTHETICxPLANTx0003`,
	'invite-private': () => `"${IPRIV}":"SYNTHETICxPLANTx0004xKEY"`,
	'raw-chain': () => 'MII' + 'Cs' + 'SYNTHETICxPLANTxCHAINx'.repeat(8),
	'image-data': () => `${'data:' + 'image/'}png;base64,iVBORw0KGgoSYNTHETIC`,
	'vote-needle': () => 'vt64' + '-needle-' + 'plant0001',
	'known-secret': () => 'Kp7vQ2mX9' + 'dLr4TzB8wYc1' + 'NfH6sJa3Ue5G' + 'oV0iRx2',
	'known-window': () => PLANTS['known-secret']().slice(10, 26),
	'device-id': () => `"${dev('Id')}":"d0d0d0d0d0d0d0d1"`,
	'device-id-column': () => `"${'De' + 'viceId'}":"d6d6d6d6d6d6d6d2"`,
	nonce: () => `"${non('ce')}":"00000000-synthetic-plant-0001"`,
	'nonce-column': () => `"${'No' + 'nce'}":"00000000-synthetic-plant-0002"`,
	'attestation-field': () => `"${'attestation' + 'Statement'}":"o2NmbXRvU1lOVEhFVElDeFBMQU5U"`,
	'attestation-details-column': () => `"${'Attestation' + 'Details'}":"{\\"plant\\":1}"`,
	'capture-shape': () => `{"v":1,"probe":"${PROBE_ID}1","rows":[{"RegistrantId":"plant"}]}`,
	markup: () => '<' + 'invoke name="plant">',
	'pm-clear': () => `adb -s emulator-5554 shell "${'pm' + ' clear'} org.votetorrent.voter"`,
	'pgrep-dash-e': () => 'pgrep' + ' -fl -E ' + "'jest|mocha'",
	'mention-vtjoin1': () => `rejects text without the ${JOIN}1. prefix`,
	'mention-sereus-invite': () => `${INVITE}1. is the invitation prefix`,
	'mention-invite-private': () => `a WRONG ${IPRIV} is refused`,
	'mention-device-id-code': () => `const probe = { ${dev('Id')}: probeDeviceToken, ${non('ce')}Length: 36 }`,
};
const fillPlants = (s) =>
	s.replace(/\{\{PLANT:([a-z0-9-]+)\}\}/g, (_, k) => {
		if (!PLANTS[k]) throw new Error('unknown placeholder kind');
		return PLANTS[k]();
	});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const GIT_C = ['-c', 'user.name=selftest', '-c', 'user.email=selftest@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
function gitRun(cwd, args) {
	execFileSync('git', [...GIT_C, ...args], { cwd, env: GIT_ENV, stdio: 'ignore' });
}

function applyOps(caseRoot, secretsPath, ops) {
	const extra = [];
	for (const op of ops) {
		const p = op.path ? join(caseRoot, op.path) : null;
		if (op.op === 'write') {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, fillPlants(op.content));
		} else if (op.op === 'append') appendFileSync(p, fillPlants(op.content));
		else if (op.op === 'delete') rmSync(p, { recursive: true, force: true });
		else if (op.op === 'move') {
			mkdirSync(dirname(join(caseRoot, op.to)), { recursive: true });
			renameSync(join(caseRoot, op.from), join(caseRoot, op.to));
		} else if (op.op === 'symlink') {
			mkdirSync(dirname(p), { recursive: true });
			symlinkSync(op.target, p);
		} else if (op.op === 'git-init') {
			gitRun(caseRoot, ['init', '-q']);
			gitRun(caseRoot, ['add', '-A']);
			gitRun(caseRoot, ['commit', '-q', '-m', 'base']);
		} else if (op.op === 'git-commit') {
			gitRun(caseRoot, ['add', '-A']);
			gitRun(caseRoot, ['commit', '-q', '-m', 'case']);
		} else if (op.op === 'secrets-file') {
			writeFileSync(secretsPath, fillPlants(op.secret) + '\n');
			extra.push('--secrets-file', secretsPath);
		} else throw new Error('unknown op');
	}
	return extra;
}

function listRaw(dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) listRaw(p, out);
		else if (e.isFile()) out.push(p);
	}
	return out;
}

function selfTrip() {
	const replay = join(REPO, ...REPLAY_REL);
	const targets = [SELF, ...listRaw(FIXTURES)];
	for (const n of ['replay-association.ts', 'README.md']) if (existsSync(join(replay, n))) targets.push(join(replay, n));
	let bad = 0;
	for (const f of targets) {
		const text = readFileSync(f, 'utf8');
		const hits = [...textRules('D', f, basename(f), text, null), ...textRules('H', f, basename(f), text, null)];
		if (hits.length) {
			bad++;
			console.log(`SELFTRIP BAD ${relative(REPO, f)} tokens=${[...new Set(hits.map((h) => h.token))].join(',')}`);
		}
	}
	if (!bad) console.log(`SELFTRIP PASS files=${targets.length}`);
	return !bad;
}

function runSelftest() {
	if (MUTATE) {
		if (!MUTATIONS.includes(MUTATE)) return 2;
		console.log(`MUTATION ${MUTATE}`);
	}
	const prefix = join(tmpdir(), 'vt64-evidence-selftest-');
	const parent = mkdtempSync(prefix);
	let ok = 0;
	let total = 0;
	try {
		total++;
		if (selfTrip()) ok++;
		const names = readdirSync(join(FIXTURES, 'cases'))
			.filter((n) => n.endsWith('.json'))
			.sort();
		for (const file of names) {
			total++;
			const name = file.replace(/\.json$/, '');
			const c = JSON.parse(readFileSync(join(FIXTURES, 'cases', file), 'utf8'));
			const dir = join(parent, name);
			const caseRoot = join(dir, 'root');
			mkdirSync(dir);
			cpSync(join(FIXTURES, c.base), caseRoot, { recursive: true });
			const extra = applyOps(caseRoot, join(dir, 'secrets.txt'), c.ops);
			selftestKnown = (c.knownOverwrites ?? []).map((k) => ({
				root: k.root,
				rel: k.rel,
				before: blobId(Buffer.from(k.beforeContent)),
				after: blobId(Buffer.from(k.afterContent)),
			}));
			let res;
			try {
				res = runChecker([...(c.args ?? []), ...extra, caseRoot]);
			} finally {
				selftestKnown = [];
			}
			const tokens = [...new Set(res.tokens)];
			const pass = c.expect === 'PASS';
			const want = pass ? [] : [c.expect, ...(c.expectAlso ?? [])];
			let good = pass ? res.exitCode === 0 : res.exitCode === 1 && tokens.length === want.length && want.every((t) => tokens.includes(t));
			if (good && (name === 'pass-device' || name === 'pass-streak-restart' || name === 'pass-streak-restart-e12' || name === 'pass-streak-restart-e15' || name === 'pass-streak-restart-e23' || name === 'pass-streak-restart-e77' || name === 'pass-streak-restart-e81' || name === 'pass-streak-restart-e83' || name === 'pass-streak-restart-e84' || name === 'pass-streak-restart-e85' || name === 'pass-streak-restart-e86') && !res.lines.some((l) => l.indexOf('STREAK PASS k=3') === 0)) good = false;
			if (good) {
				ok++;
				console.log(`CASE ${name} OK`);
			} else console.log(`CASE ${name} BAD expect=${c.expect} got=${tokens.length ? tokens.join('|') : 'PASS'} exit=${res.exitCode}`);
		}
	} finally {
		if (parent.slice(0, prefix.length) === prefix) rmSync(parent, { recursive: true, force: true });
	}
	console.log(ok === total && total === 97 ? `SELFTEST PASS ${ok}/${total}` : `SELFTEST FAIL ${ok}/97`);
	return ok === total && total === 97 ? 0 : 1;
}

function main(argv) {
	let code;
	try {
		if (argv.includes('--selftest')) {
			if (argv.length !== 1) throw new Err('usage');
			code = runSelftest();
			if (code === 2) console.log('ERROR usage');
		} else {
			if (MUTATE) throw new Err('mutate-refused');
			const res = runChecker(argv);
			for (const l of res.lines) console.log(l);
			code = res.exitCode;
		}
	} catch (e) {
		if (!(e instanceof Err)) throw e;
		console.log(`ERROR ${e.token}`);
		code = 2;
	}
	process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main(process.argv.slice(2));
