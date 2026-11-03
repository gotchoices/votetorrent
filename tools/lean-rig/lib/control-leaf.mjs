// control-leaf.mjs - the one reader of the party control collection's CadrePeer leaf and log tail (plan 64-60,
// notes 19 E23 and E26, Defaults D-A5-03 and D-A5-04).
//
// A control fork is two Authorities holding the SAME CadrePeer revision with DIFFERENT content: db-p2p's promise-round digest
// check then refuses every later write of either side for good. E23 makes a fork precheck a STOP gate before every run part and
// after every app restart (D-21: a fork is recorded, never worked around). This module is the instrument, shared by the CDP
// verb (the same source text runs inside the device app), the fork-precheck.sh wrapper and the Node rehearsals (64-62, 64-63),
// which import classifyRound, forkPrecheckLine and forkPrecheck by absolute file URL and re-implement none of them.
//
// Access path, in words: the app context's node gives the control libp2p node through getControlNode(); its storageRepo
// creates a block storage per block id. The collection header block (collection id default/cadrecontrol/CadrePeer, block type
// TRE) names the tree root (the leaf) and the log tail by rootId and tailId. The leaf and the tail are each read with one
// getLatest() (rev and actionId); the header's own latest rev lags the leaf (it changes only when the tail block changes), so
// the ids come from the header block and are never hard-coded. Everything is a LOCAL read: getBlock never fetches or restores.
// The result is reduced in place to revs and 8-character action prefixes: block ids, peer ids and full action ids are never
// returned. A transaction-layer action id on a Node CadreNode carries a constant tx-colon namespace prefix (the device's ids are 22
// base64url characters with none); the prefix is dropped before the first 8 characters are taken, so the 8 characters are
// always hash characters. For an id with no such prefix the value is the plain first 8 characters.
//
// Importing this module has no side effect: no output, no timer, no network, no process listener. The CLI below runs only when
// the file is the main module.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CADRE_PEER_COLLECTION = 'default/cadrecontrol/CadrePeer';
export const FORK_SPACING_MS = 5000;
export const FORK_CAP_MS = 120000;
export const FAIL_TOKENS = ['fork-leaf', 'fork-tail', 'unreadable', 'role-missing', 'digest-mismatch-logged'];

const ROLE_RE = /^[a-z0-9-]{1,16}$/;
const ACTION8_RE = /^[A-Za-z0-9_-]{8}$/;
const KEYS = ['leafRev', 'leafAction8', 'tailRev', 'tailAction8'];

// Hermes-safe: `function` and `var` only, no comment anywhere in the text, none of the Hermes rule's words even in prose.
export const CONTROL_LEAF_SOURCE = [
	'function (node, A) {',
	'  function bad(t) { return { unreadable: t }; }',
	'  function a8(x) { if (x === undefined || x === null) return null; var s = String(x); if (s.indexOf("tx:") === 0) s = s.slice(3); s = s.slice(0, 8); return /^[A-Za-z0-9_-]{8}$/.test(s) ? s : null; }',
	'  function okRev(v) { return v && typeof v.rev === "number" && Math.floor(v.rev) === v.rev && v.rev >= 0; }',
	'  try {',
	'    var cn = node && typeof node.getControlNode === "function" ? node.getControlNode() : null;',
	'    if (!cn) return Promise.resolve(bad("no-control-node"));',
	'    var repo = cn.storageRepo;',
	'    if (!repo || typeof repo.createBlockStorage !== "function") return Promise.resolve(bad("no-storage-repo"));',
	'    var coll = A && typeof A.collection === "string" && A.collection ? A.collection : ' + JSON.stringify(CADRE_PEER_COLLECTION) + ';',
	'    var h = repo.createBlockStorage(coll);',
	'    return Promise.resolve(h.getLatest()).then(function (hl) {',
	'      if (!hl || typeof hl.rev !== "number") return bad("no-header");',
	'      return Promise.resolve(h.getBlock(hl.rev)).then(function (got) {',
	'        var b = got && got.block;',
	'        if (!b || typeof b.rootId !== "string" || !b.rootId || typeof b.tailId !== "string" || !b.tailId) return bad("header-shape");',
	'        var lb = repo.createBlockStorage(b.rootId);',
	'        var tb = repo.createBlockStorage(b.tailId);',
	'        return Promise.resolve(lb.getLatest()).then(function (leaf) {',
	'          if (!leaf) return bad("no-leaf");',
	'          return Promise.resolve(tb.getLatest()).then(function (tail) {',
	'            if (!tail) return bad("no-tail");',
	'            var la = a8(leaf.actionId);',
	'            var ta = a8(tail.actionId);',
	'            if (!okRev(leaf) || !okRev(tail) || !la || !ta) return bad("shape");',
	'            return { leafRev: leaf.rev, leafAction8: la, tailRev: tail.rev, tailAction8: ta };',
	'          });',
	'        });',
	'      });',
	'    }).then(null, function () { return bad("read-threw"); });',
	'  } catch (e) {',
	'    return Promise.resolve(bad("read-threw"));',
	'  }',
	'}',
].join('\n');

let compiled = null;
/** Resolves (never rejects) to {leafRev, leafAction8, tailRev, tailAction8} or {unreadable: <token>}. */
export async function readControlLeaf(node) {
	if (!compiled) compiled = new Function('return (' + CONTROL_LEAF_SOURCE + ')')();
	try {
		return await compiled(node, {});
	} catch {
		return { unreadable: 'read-threw' };
	}
}

function validRead(r) {
	if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
	const k = Object.keys(r).sort().join(',');
	if (k !== [...KEYS].sort().join(',')) return false;
	return Number.isInteger(r.leafRev) && r.leafRev >= 0 && Number.isInteger(r.tailRev) && r.tailRev >= 0 &&
		typeof r.leafAction8 === 'string' && ACTION8_RE.test(r.leafAction8) && typeof r.tailAction8 === 'string' && ACTION8_RE.test(r.tailAction8);
}

/** readsByRole: {role: read}. Returns {verdict, values?}; verdict is agree | fork-leaf | fork-tail | unreadable. */
export function classifyRound(readsByRole) {
	const reads = readsByRole && typeof readsByRole === 'object' ? Object.values(readsByRole) : [];
	if (reads.length === 0 || !reads.every(validRead)) return { verdict: 'unreadable' };
	const first = reads[0];
	if (reads.some((r) => r.leafRev !== first.leafRev || r.leafAction8 !== first.leafAction8)) return { verdict: 'fork-leaf' };
	if (reads.some((r) => r.tailRev !== first.tailRev || r.tailAction8 !== first.tailAction8)) return { verdict: 'fork-tail' };
	return { verdict: 'agree', values: { leafRev: first.leafRev, leafAction8: first.leafAction8, tailRev: first.tailRev, tailAction8: first.tailAction8 } };
}

function rolesValid(roles) {
	if (!Array.isArray(roles) || roles.length < 2) return false;
	if (!roles.every((r) => typeof r === 'string' && ROLE_RE.test(r))) return false;
	return new Set(roles).size === roles.length;
}

/** The ONLY formatter of line 1 and the ONLY place the single-token precedence lives. */
export function forkPrecheckLine(v) {
	const x = v ?? {};
	const fail = (t) => 'FORK-PRECHECK: FAIL ' + t;
	if (!rolesValid(x.roles) || x.verdict === 'role-missing') return fail('role-missing');
	const dig = x.digestMismatch;
	if (Number.isInteger(dig) && dig > 0) return fail('digest-mismatch-logged');
	if (x.verdict === 'agree') {
		const at = typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) && new Date(x.at).toISOString() === x.at;
		if (!validRead(x.values) || !Number.isInteger(dig) || dig !== 0 || !Number.isInteger(x.reads) || x.reads < 1 || !at) return fail('unreadable');
		const o = x.values;
		return 'FORK-PRECHECK: PASS roles=' + x.roles.join(',') + ' leafRev=' + o.leafRev + ' leafAction8=' + o.leafAction8 + ' tailRev=' + o.tailRev +
			' tailAction8=' + o.tailAction8 + ' digestMismatch=0 reads=' + x.reads + ' at=' + x.at;
	}
	if (FAIL_TOKENS.includes(x.verdict)) return fail(x.verdict);
	return fail('unreadable');
}

/**
 * readers: {role: () => Promise<read>} (at least 2, roles ^[a-z0-9-]{1,16}$). Rounds start at 0, spacingMs, 2*spacingMs ... up to capMs;
 * every round reads every role; the first agree round ends the loop; then digestMismatch() (default 0) is read once.
 * Resolves {line, rounds, last}.
 */
export async function forkPrecheck(opts) {
	const o = opts ?? {};
	const spacingMs = o.spacingMs ?? FORK_SPACING_MS;
	const capMs = o.capMs ?? FORK_CAP_MS;
	const now = o.now ?? (() => Date.now());
	const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const readers = o.readers && typeof o.readers === 'object' ? o.readers : {};
	const roles = Object.keys(readers);
	if (!rolesValid(roles) || !roles.every((r) => typeof readers[r] === 'function')) {
		return { line: forkPrecheckLine({ roles, verdict: 'role-missing', digestMismatch: 0, reads: 0, at: new Date(now()).toISOString() }), rounds: 0, last: {} };
	}
	const t0 = now();
	let rounds = 0;
	let last = {};
	let verdict = 'unreadable';
	let values;
	let at = new Date(t0).toISOString();
	for (let k = 0; k * spacingMs <= capMs; k++) {
		if (k > 0) {
			if (now() - t0 > capMs) break;
			await sleep(spacingMs);
		}
		const round = {};
		for (const role of roles) {
			try {
				round[role] = await readers[role]();
			} catch {
				round[role] = { unreadable: 'read-threw' };
			}
		}
		rounds++;
		last = round;
		const c = classifyRound(round);
		verdict = c.verdict;
		values = c.values;
		at = new Date(now()).toISOString();
		if (verdict === 'agree') break;
	}
	let digest = 0;
	if (typeof o.digestMismatch === 'function') {
		try {
			digest = Number(await o.digestMismatch());
		} catch {
			digest = NaN;
		}
	}
	if (!Number.isInteger(digest) || digest < 0) {
		return { line: forkPrecheckLine({ roles, verdict: 'unreadable', digestMismatch: 0, reads: rounds, at }), rounds, last };
	}
	return { line: forkPrecheckLine({ roles, verdict, values, digestMismatch: digest, reads: rounds, at }), rounds, last };
}

// ---- CLI (fork-precheck.sh) -------------------------------------------------------------------------------
function cliClassify(args) {
	if (args.length < 1) return 2;
	const reads = {};
	for (const a of args) {
		const m = /^([a-z0-9-]{1,16})=(.+)$/.exec(a);
		if (!m) return 2;
		let read = null;
		try {
			const text = readFileSync(m[2], 'utf8');
			const obj = JSON.parse(text.trim().replace(/^CDP /, ''));
			const res = obj && obj.result;
			const keys = res && typeof res === 'object' ? Object.keys(res).sort().join(',') : '';
			if (obj && obj.ok === true && obj.verb === 'control-leaf' && keys === [...KEYS].sort().join(',')) read = res;
		} catch {
			read = null;
		}
		reads[m[1]] = read ?? { unreadable: 'cdp' };
	}
	console.log(JSON.stringify(classifyRound(reads)));
	return 0;
}

function cliLine(args) {
	const f = {};
	for (let i = 0; i < args.length; i += 2) {
		if (!args[i].startsWith('--') || args[i + 1] === undefined) return 2;
		f[args[i].slice(2)] = args[i + 1];
	}
	for (const k of ['roles', 'verdict', 'digest', 'reads', 'at']) if (typeof f[k] !== 'string') return 2;
	let values;
	if (f['values-json'] !== undefined) {
		try {
			values = JSON.parse(f['values-json']);
		} catch {
			return 2;
		}
	}
	if (!/^[0-9]+$/.test(f.digest) || !/^[0-9]+$/.test(f.reads)) return 2;
	console.log(forkPrecheckLine({ roles: f.roles.split(','), verdict: f.verdict, values, digestMismatch: Number(f.digest), reads: Number(f.reads), at: f.at }));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [cmd, ...rest] = process.argv.slice(2);
	let code = 2;
	if (cmd === 'classify') code = cliClassify(rest);
	else if (cmd === 'line') code = cliLine(rest);
	process.exit(code);
}
