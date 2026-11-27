#!/usr/bin/env node
/**
 * analyze-read-repair.mjs — turn an armed device logcat into the read-repair verdict.
 *
 * WHAT THIS DECIDES
 * -----------------
 * Optimystic issue #8 (gotchoices/Optimystic) resolved to a defect in
 * `CoordinatorRepo.fetchBlockFromCluster`: its solo-cluster short-circuit returned without
 * calling `markBlocksSeen`, so `lastSeenCommitMs` was never stamped, so `shouldReadRepair`
 * saw `lastSeen == null` and returned true on EVERY read, forever:
 *
 *     read -> "stale" -> consult -> solo-self-skip -> no-op -> still "stale"
 *
 * Fixed in @optimystic/db-p2p 0.29.0. It reproduces only when the cohort is exactly one
 * peer and that peer is self — i.e. precisely a founder creating a network with no peers.
 *
 * The decisive evidence is NOT the log volume. `cluster-tx:read-repair-triggered` carries
 * `ageMs`, which `CoordinatorRepo.ageMs()` computes as `now - lastSeen`, returning
 * `undefined` when the block was never marked seen. So each triggered event self-classifies:
 *
 *   ageMs ABSENT        -> lastSeen was null       -> the window was NEVER ARMED (the defect)
 *   ageMs >  windowMs   -> the window lapsed       -> healthy, expected re-trigger
 *   ageMs <= windowMs   -> re-entered while armed  -> the RESIDUAL upstream reports on 0.29.0
 *
 * `readRepairSampleRate` defaults to 0, so there is no random re-trigger to confound the
 * third bucket. Gap analysis (upstream's method, which had to infer this from outside) is
 * still computed as independent corroboration.
 *
 * INPUT FORMAT
 * ------------
 * Lines emitted by the app's `armDebugNamespaces()` sink, anywhere in a logcat:
 *
 *   [optidbg] <emitEpochMs> | <namespace> | <marker> | <json payload>
 *
 * The embedded emit timestamp is used for all timing, never logcat's own — logcat stamps a
 * line when the RN console bridge DELIVERS it, which batching can smear past the millisecond
 * gaps that matter here.
 *
 * Usage:
 *   node scripts/lib/analyze-read-repair.mjs --in CAPTURE [--window-ms 10000] [--json OUT]
 *   node scripts/lib/analyze-read-repair.mjs --selftest
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[optidbg]';
const DEFAULT_WINDOW_MS = 10000;

/** Markers this analyzer understands, all from `optimystic:db-p2p:coordinator-repo:*`. */
const MARKERS = {
	triggered: 'cluster-tx:read-repair-triggered',
	noop: 'cluster-tx:read-repair-noop',
	soloSkip: 'cluster-fetch:solo-self-skip',
	localCurrent: 'cluster-fetch:local-current',
	soloCommit: 'commit:solo-cohort',
};

/**
 * Parse one armed line. Returns null for any line that is not one of ours, so a raw
 * device-wide logcat can be passed in directly.
 *
 * The payload is the LAST ' | '-separated field and is JSON; the marker may itself contain
 * no ' | ', which is why the split is bounded rather than greedy.
 */
export function parseLine(line) {
	const at = line.indexOf(PREFIX);
	if (at < 0) return null;
	const rest = line.slice(at + PREFIX.length).trim();
	// "armed namespaces=..." provenance line, not an event.
	if (rest.startsWith('armed ')) {
		return { kind: 'armed', detail: rest.slice(6).replace(/^namespaces=/, '') };
	}

	const fields = rest.split(' | ');
	if (fields.length < 3) return null;
	const emitMs = Number(fields[0]);
	if (!Number.isFinite(emitMs)) return null;
	const namespace = fields[1];
	const marker = fields[2];
	let payload = {};
	if (fields.length >= 4) {
		try {
			payload = JSON.parse(fields.slice(3).join(' | '));
		} catch {
			payload = {};
		}
	}
	return { kind: 'event', emitMs, namespace, marker, payload };
}

function median(values) {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Classify triggered events and compute per-block repeat gaps.
 *
 * `ageMs` classification and gap classification are deliberately INDEPENDENT: the first
 * reads the node's own view of its window, the second reconstructs it from the outside the
 * way upstream had to. They should agree; if they do not, that disagreement is itself the
 * finding, so neither is derived from the other.
 */
export function analyze(lines, { windowMs = DEFAULT_WINDOW_MS } = {}) {
	const events = [];
	let armedLine = null;
	for (const line of lines) {
		const parsed = parseLine(line);
		if (!parsed) continue;
		if (parsed.kind === 'armed') { armedLine = parsed.detail; continue; }
		events.push(parsed);
	}

	const counts = {};
	for (const key of Object.keys(MARKERS)) counts[key] = 0;
	let otherMarkers = 0;
	const byMarker = new Map();
	for (const ev of events) {
		const key = Object.keys(MARKERS).find(k => MARKERS[k] === ev.marker);
		if (key) counts[key] += 1; else otherMarkers += 1;
		if (!byMarker.has(ev.marker)) byMarker.set(ev.marker, []);
		byMarker.get(ev.marker).push(ev);
	}

	const triggered = byMarker.get(MARKERS.triggered) ?? [];

	// --- ageMs classification (the node's own view of its window) ---
	const ageBuckets = { neverArmed: 0, lapsed: 0, insideWindow: 0, unparsed: 0 };
	const perBlock = new Map();
	const blockOf = ev => (typeof ev.payload?.blockId === 'string' ? ev.payload.blockId : null);
	for (const ev of triggered) {
		const blockId = blockOf(ev);
		if (blockId === null) { ageBuckets.unparsed += 1; continue; }
		if (!perBlock.has(blockId)) {
			perBlock.set(blockId, {
				blockId, total: 0, neverArmed: 0, lapsed: 0, insideWindow: 0,
				emitTimes: [], gapsInside: [], gapsAtOrOver: [],
			});
		}
		const rec = perBlock.get(blockId);
		rec.total += 1;
		rec.emitTimes.push(ev.emitMs);
		// `ageMs` absent means CoordinatorRepo.ageMs() returned undefined, i.e. lastSeen was
		// null. JSON.stringify omits undefined properties, so absence IS the signal.
		const age = ev.payload.ageMs;
		if (age === undefined || age === null) { ageBuckets.neverArmed += 1; rec.neverArmed += 1; }
		else if (age > windowMs) { ageBuckets.lapsed += 1; rec.lapsed += 1; }
		else { ageBuckets.insideWindow += 1; rec.insideWindow += 1; }
	}

	// --- gap classification (reconstructed from outside, upstream's method) ---
	const allGapsInside = [];
	const allGapsAtOrOver = [];
	for (const rec of perBlock.values()) {
		rec.emitTimes.sort((a, b) => a - b);
		for (let i = 1; i < rec.emitTimes.length; i++) {
			const gap = rec.emitTimes[i] - rec.emitTimes[i - 1];
			if (gap < windowMs) { rec.gapsInside.push(gap); allGapsInside.push(gap); }
			else { rec.gapsAtOrOver.push(gap); allGapsAtOrOver.push(gap); }
		}
	}
	const subSecond = allGapsInside.filter(g => g < 1000);

	// --- progress / convergence ---
	const first = events.length ? Math.min(...events.map(e => e.emitMs)) : null;
	const last = events.length ? Math.max(...events.map(e => e.emitMs)) : null;
	const cumulativeDistinct = [];
	if (first !== null) {
		for (const minutes of [2, 5, 10, 20]) {
			const cutoff = first + minutes * 60000;
			if (last < cutoff - 60000) continue; // window not reached by this capture
			const seen = new Set();
			for (const ev of triggered) {
				const b = blockOf(ev);
				if (b !== null && ev.emitMs <= cutoff) seen.add(b);
			}
			cumulativeDistinct.push({ minutes, distinctBlocks: seen.size });
		}
	}

	// --- 60s windows (n8allan's "lines vs distinct ids, deep in" ask) ---
	const minuteWindows = [];
	if (first !== null) {
		for (let start = first; start < last; start += 60000) {
			const end = start + 60000;
			const inWin = events.filter(e => e.emitMs >= start && e.emitMs < end);
			if (inWin.length === 0) continue;
			const ids = new Set();
			for (const ev of inWin) { const b = blockOf(ev); if (b !== null) ids.add(b); }
			minuteWindows.push({
				minute: Math.round((start - first) / 60000),
				lines: inWin.length,
				distinctBlocks: ids.size,
				commits: inWin.filter(e => e.marker === MARKERS.soloCommit).length,
			});
		}
	}

	// --- solo commits (cohortSize / soleIsSelf: routing degraded vs genuinely solo) ---
	const soloCommits = byMarker.get(MARKERS.soloCommit) ?? [];
	const cohortSizes = new Set();
	const soleIsSelfValues = new Set();
	const commitBlocks = new Set();
	for (const ev of soloCommits) {
		if (ev.payload?.cohortSize !== undefined) cohortSizes.add(ev.payload.cohortSize);
		if (ev.payload?.soleIsSelf !== undefined) soleIsSelfValues.add(ev.payload.soleIsSelf);
		const b = blockOf(ev);
		if (b !== null) commitBlocks.add(b);
	}

	const distinctSkipBlocks = new Set();
	for (const ev of byMarker.get(MARKERS.soloSkip) ?? []) {
		const b = blockOf(ev);
		if (b !== null) distinctSkipBlocks.add(b);
	}

	return {
		armedLine,
		windowMs,
		totalEvents: events.length,
		otherMarkers,
		firstEmitMs: first,
		lastEmitMs: last,
		durationMs: first === null ? 0 : last - first,
		counts,
		ageBuckets,
		triggeredNoopRatio: counts.noop === 0 ? null : counts.triggered / counts.noop,
		distinctTriggeredBlocks: perBlock.size,
		distinctSkipBlocks: distinctSkipBlocks.size,
		perBlock: [...perBlock.values()].sort((a, b) => b.total - a.total),
		gaps: {
			insideWindow: { n: allGapsInside.length, medianMs: median(allGapsInside) },
			atOrOverWindow: { n: allGapsAtOrOver.length, medianMs: median(allGapsAtOrOver) },
			subSecond: { n: subSecond.length, minMs: subSecond.length ? Math.min(...subSecond) : null },
		},
		cumulativeDistinct,
		minuteWindows,
		soloCommits: {
			total: soloCommits.length,
			distinctBlocks: commitBlocks.size,
			cohortSizes: [...cohortSizes],
			soleIsSelfValues: [...soleIsSelfValues],
		},
	};
}

/**
 * The verdict. Deliberately refuses to answer when the capture cannot support one — a
 * capture with no armed lines is an UNARMED instrument, not evidence of a healthy node,
 * and that distinction is the exact trap this whole instrument exists to remove.
 */
export function verdict(r) {
	if (r.armedLine === null && r.totalEvents === 0) {
		return {
			code: 'UNARMED',
			text: 'No [optidbg] lines at all. The debug namespaces were never armed in the build '
				+ 'that produced this capture — this says NOTHING about whether read-repair looped. '
				+ 'Re-run with scripts/run-read-repair-capture.sh and confirm its provenance step.',
		};
	}
	if (r.counts.triggered === 0) {
		return {
			code: 'NO-TRIGGERS',
			text: 'Armed, but zero read-repair-triggered events. Either the coordinated read path '
				+ 'never ran in this window, or the capture missed it.',
		};
	}
	const { neverArmed, lapsed, insideWindow } = r.ageBuckets;
	const dominant = Math.max(neverArmed, lapsed, insideWindow);
	if (dominant === neverArmed && neverArmed > lapsed + insideWindow) {
		return {
			code: 'NEVER-ARMED-LOOP',
			text: `${neverArmed}/${r.counts.triggered} triggered events report NO ageMs, i.e. `
				+ 'lastSeenCommitMs was never stamped. This is the Optimystic issue #8 defect: the '
				+ 'solo short-circuit returns without markBlocksSeen, so the window can never arm '
				+ 'and every read re-triggers. Fixed in @optimystic/db-p2p 0.29.0.',
		};
	}
	if (insideWindow > 0 && insideWindow >= lapsed) {
		return {
			code: 'SUB-WINDOW-RESIDUAL',
			text: `${insideWindow}/${r.counts.triggered} triggered events re-entered with ageMs `
				+ `<= ${r.windowMs}ms, i.e. the window WAS armed and was re-entered anyway. This is `
				+ 'the residual upstream reports against 0.29.0 (concentrated on blocks that are '
				+ 'empty on a fresh party, e.g. default/Revocation), not the original defect.',
		};
	}
	return {
		code: 'HEALTHY',
		text: `${lapsed}/${r.counts.triggered} triggered events report a lapsed window `
			+ `(ageMs > ${r.windowMs}ms), which is the intended behaviour. The window is arming.`,
	};
}

function fmtMs(ms) {
	if (ms === null || ms === undefined) return 'n/a';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

export function report(r) {
	const v = verdict(r);
	const out = [];
	out.push('# Read-repair capture analysis');
	out.push('');
	out.push(`VERDICT: ${v.code}`);
	out.push(v.text.replace(/(.{1,96})(\s|$)/g, '$1\n').trim());
	out.push('');
	out.push('## Machine-greppable summary');
	out.push('');
	out.push(`verdict: ${v.code}`);
	out.push(`armed_namespaces: ${r.armedLine ?? 'NONE — instrument was not armed'}`);
	out.push(`read_repair_window_ms: ${r.windowMs}`);
	out.push(`capture_duration: ${fmtMs(r.durationMs)}`);
	out.push(`total_armed_events: ${r.totalEvents}`);
	out.push(`read_repair_triggered: ${r.counts.triggered}`);
	out.push(`read_repair_noop: ${r.counts.noop}`);
	out.push(`solo_self_skip: ${r.counts.soloSkip}`);
	out.push(`local_current: ${r.counts.localCurrent}`);
	out.push(`commit_solo_cohort: ${r.soloCommits.total}`);
	out.push(`triggered_noop_ratio: ${r.triggeredNoopRatio === null ? 'n/a' : r.triggeredNoopRatio.toFixed(4)}`);
	out.push(`distinct_triggered_blocks: ${r.distinctTriggeredBlocks}`);
	out.push(`distinct_skip_blocks: ${r.distinctSkipBlocks}`);
	out.push(`agems_never_armed: ${r.ageBuckets.neverArmed}`);
	out.push(`agems_lapsed: ${r.ageBuckets.lapsed}`);
	out.push(`agems_inside_window: ${r.ageBuckets.insideWindow}`);
	out.push(`gaps_inside_window: n=${r.gaps.insideWindow.n} median=${fmtMs(r.gaps.insideWindow.medianMs)}`);
	out.push(`gaps_at_or_over_window: n=${r.gaps.atOrOverWindow.n} median=${fmtMs(r.gaps.atOrOverWindow.medianMs)}`);
	out.push(`gaps_sub_second: n=${r.gaps.subSecond.n} min=${fmtMs(r.gaps.subSecond.minMs)}`);
	out.push(`cohort_sizes: ${JSON.stringify(r.soloCommits.cohortSizes)}`);
	out.push(`sole_is_self: ${JSON.stringify(r.soloCommits.soleIsSelfValues)}`);
	out.push('');

	out.push('## ageMs classification of read-repair-triggered');
	out.push('');
	out.push('| bucket | meaning | n |');
	out.push('|---|---|---|');
	out.push(`| ageMs absent | lastSeen was null — window NEVER ARMED (issue #8 defect) | ${r.ageBuckets.neverArmed} |`);
	out.push(`| ageMs > ${r.windowMs}ms | window lapsed — healthy re-trigger | ${r.ageBuckets.lapsed} |`);
	out.push(`| ageMs <= ${r.windowMs}ms | re-entered while armed — 0.29.0 residual | ${r.ageBuckets.insideWindow} |`);
	if (r.ageBuckets.unparsed > 0) out.push(`| unparsed | payload had no blockId | ${r.ageBuckets.unparsed} |`);
	out.push('');

	out.push('## Repeat gaps per block (independent corroboration, upstream\'s method)');
	out.push('');
	out.push('| | n | median gap |');
	out.push('|---|---|---|');
	out.push(`| repeats at/over the ${r.windowMs}ms window | ${r.gaps.atOrOverWindow.n} | ${fmtMs(r.gaps.atOrOverWindow.medianMs)} |`);
	out.push(`| repeats inside the window | ${r.gaps.insideWindow.n} | ${fmtMs(r.gaps.insideWindow.medianMs)} |`);
	out.push(`| sub-second repeats | ${r.gaps.subSecond.n} | min ${fmtMs(r.gaps.subSecond.minMs)} |`);
	out.push('');

	if (r.perBlock.length > 0) {
		out.push('## Per-block breakdown (top 15 by trigger count)');
		out.push('');
		out.push('| block | triggered | never-armed | lapsed | inside-window | sub-window gaps / total gaps |');
		out.push('|---|---|---|---|---|---|');
		for (const b of r.perBlock.slice(0, 15)) {
			const totalGaps = b.gapsInside.length + b.gapsAtOrOver.length;
			out.push(`| \`${b.blockId}\` | ${b.total} | ${b.neverArmed} | ${b.lapsed} | ${b.insideWindow} | ${b.gapsInside.length} / ${totalGaps} |`);
		}
		out.push('');
	}

	if (r.cumulativeDistinct.length > 0) {
		out.push('## Progress (is it advancing, or stuck?)');
		out.push('');
		out.push('| elapsed | cumulative distinct blocks triggered |');
		out.push('|---|---|');
		for (const c of r.cumulativeDistinct) out.push(`| ${c.minutes} min | ${c.distinctBlocks} |`);
		out.push('');
	}

	if (r.minuteWindows.length > 0) {
		out.push('## 60-second windows');
		out.push('');
		out.push('| minute | armed lines | distinct blocks | solo commits |');
		out.push('|---|---|---|---|');
		for (const w of r.minuteWindows) out.push(`| ${w.minute} | ${w.lines} | ${w.distinctBlocks} | ${w.commits} |`);
		out.push('');
	}

	return out.join('\n');
}

// ---------------------------------------------------------------------------
// --selftest : synthetic fixtures, each asserting one classification the verdict
// depends on. Every assertion is paired with a control that would break it, so a
// future edit cannot make the verdict trivially green.
// ---------------------------------------------------------------------------
function selftest() {
	let pass = 0, fail = 0;
	const eq = (expected, actual, desc) => {
		if (JSON.stringify(expected) === JSON.stringify(actual)) { pass += 1; }
		else { fail += 1; console.error(`FAIL [${desc}]: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); }
	};
	const line = (t, marker, payload) =>
		`09-10 12:00:00.000  5001  5050 I ReactNativeJS: ${PREFIX} ${t} | optimystic:db-p2p:coordinator-repo:12D3KooWaaaa | ${marker} | ${JSON.stringify(payload)}`;

	// 1. Unarmed capture must NOT read as healthy.
	const unarmed = analyze(['09-10 12:00:00.000 I/Whatever( 900): nothing to see']);
	eq('UNARMED', verdict(unarmed).code, 'a capture with no armed lines refuses a verdict');
	eq(0, unarmed.totalEvents, 'unarmed capture parses zero events');

	// 2. The issue-#8 defect: ageMs always absent (JSON omits undefined).
	const defect = [`${PREFIX} armed namespaces=optimystic:db-p2p:coordinator-repo:*`];
	for (let i = 0; i < 12; i++) {
		defect.push(line(1000 + i * 50, MARKERS.triggered, { blockId: 'default/Revocation', mode: 'lazy', ageMs: undefined }));
		defect.push(line(1000 + i * 50 + 5, MARKERS.soloSkip, { blockId: 'default/Revocation' }));
		defect.push(line(1000 + i * 50 + 9, MARKERS.noop, { blockId: 'default/Revocation' }));
	}
	const d = analyze(defect);
	eq('NEVER-ARMED-LOOP', verdict(d).code, 'ageMs-absent storm classifies as the issue-#8 defect');
	eq(12, d.ageBuckets.neverArmed, 'all 12 triggers counted as never-armed');
	eq(0, d.ageBuckets.lapsed, 'none misclassified as lapsed');
	eq(1, d.distinctTriggeredBlocks, 'one distinct block');
	eq(1, d.triggeredNoopRatio, 'the 1:1 triggered:noop ratio upstream measured');
	eq(11, d.gaps.insideWindow.n, 'gap analysis independently sees 11 sub-window repeats');

	// 3. Healthy: window arming, every re-trigger past the window.
	const healthy = [`${PREFIX} armed namespaces=x`];
	for (let i = 0; i < 6; i++) {
		healthy.push(line(1000 + i * 14000, MARKERS.triggered, { blockId: 'default/Strand', mode: 'lazy', ageMs: 14000 }));
	}
	const h = analyze(healthy);
	eq('HEALTHY', verdict(h).code, 'lapsed-window re-triggers classify as healthy');
	eq(6, h.ageBuckets.lapsed, 'all six counted as lapsed');
	eq(0, h.gaps.insideWindow.n, 'no sub-window gaps in the healthy fixture');

	// 4. The 0.29.0 residual: window armed, re-entered inside it anyway.
	const residual = [`${PREFIX} armed namespaces=x`];
	for (let i = 0; i < 9; i++) {
		residual.push(line(1000 + i * 17, MARKERS.triggered, { blockId: 'default/Revocation', mode: 'lazy', ageMs: 17 }));
	}
	const res = analyze(residual);
	eq('SUB-WINDOW-RESIDUAL', verdict(res).code, 'armed-but-re-entered classifies as the 0.29.0 residual');
	eq(9, res.ageBuckets.insideWindow, 'all nine counted inside the window');
	eq(0, res.ageBuckets.neverArmed, 'residual is NOT confused with the original defect');

	// 5. CONTROL: the two defect classes must be distinguishable. Same timing, same block,
	// same counts — ONLY ageMs presence differs. If these ever collapse to one verdict the
	// instrument cannot tell "never armed" from "armed and re-entered", which is the whole
	// question 0.29.0 turns on.
	const sameTiming = analyze(defect.map(l => l.replace('"mode":"lazy"', '"mode":"lazy","ageMs":17')));
	eq('SUB-WINDOW-RESIDUAL', verdict(sameTiming).code,
		'CONTROL: identical timing + an ageMs value flips the verdict away from NEVER-ARMED-LOOP');
	eq(d.gaps.insideWindow.n, sameTiming.gaps.insideWindow.n,
		'CONTROL: gap analysis alone CANNOT separate them — identical sub-window gap counts');

	// 6. Parser robustness: our lines are found inside device-wide logcat noise, and a
	// non-JSON payload degrades to an unparsed payload rather than throwing.
	const noisy = analyze([
		'09-10 12:00:00.000 D/SomeOtherApp( 700): unrelated',
		line(5000, MARKERS.soloCommit, { blockId: 'default/Strand', cohortSize: 1, soleIsSelf: true }),
		`${PREFIX} 6000 | ns | ${MARKERS.triggered} | {not json`,
	]);
	eq(1, noisy.soloCommits.total, 'solo-cohort commit parsed out of a noisy logcat');
	eq([1], noisy.soloCommits.cohortSizes, 'cohortSize extracted');
	eq([true], noisy.soloCommits.soleIsSelfValues, 'soleIsSelf extracted — routing genuinely solo, not degraded');
	eq(1, noisy.ageBuckets.unparsed, 'a malformed payload is counted, not silently dropped');

	// 7. GOLDEN BINDING. This fixture is produced by the DEVICE-side sink and asserted
	// byte-for-byte by apps/VoteTorrentAuthority/src/engines/__tests__/arm-debug-namespaces.test.ts.
	// Parsing it here means neither side of the seam can drift alone: change the emitted format
	// and that test fails; change the parser and this one does.
	const goldenPath = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/optidbg-golden.txt');
	const g = analyze(readFileSync(goldenPath, 'utf8').split('\n'));
	eq('optimystic:db-p2p:coordinator-repo:*', g.armedLine,
		'GOLDEN: the armed provenance line is recognised and its namespace extracted');
	eq(1, g.counts.triggered, 'GOLDEN: the triggered event parses');
	eq(1, g.counts.noop, 'GOLDEN: the no-op event parses');
	eq(1, g.counts.soloSkip, 'GOLDEN: the solo-self-skip event parses');
	eq(1, g.soloCommits.total, 'GOLDEN: the solo-cohort commit parses');
	eq(1, g.ageBuckets.neverArmed, 'GOLDEN: the fixture\'s omitted ageMs reads as never-armed');
	eq(0, g.ageBuckets.unparsed, 'GOLDEN: every payload in the fixture parsed');
	eq([1], g.soloCommits.cohortSizes, 'GOLDEN: cohortSize survives the round trip');
	eq([true], g.soloCommits.soleIsSelfValues, 'GOLDEN: soleIsSelf survives the round trip');

	console.log(fail === 0
		? `selftest: ${pass} assertions passed (incl. the device-side golden binding and 2 controls proving ageMs — not timing — is what separates the two defects).`
		: `selftest FAILED: ${fail}/${pass + fail} assertions failed`);
	return fail === 0 ? 0 : 1;
}

// --- CLI ---
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
	process.exit(selftest());
}
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const input = arg('--in');
if (!input) {
	console.error('usage: analyze-read-repair.mjs --in CAPTURE [--window-ms 10000] [--json OUT]');
	console.error('       analyze-read-repair.mjs --selftest');
	process.exit(2);
}
const windowMs = Number(arg('--window-ms') ?? DEFAULT_WINDOW_MS);
const result = analyze(readFileSync(input, 'utf8').split('\n'), { windowMs });
console.log(report(result));
const jsonOut = arg('--json');
if (jsonOut) {
	writeFileSync(jsonOut, JSON.stringify({ ...result, verdict: verdict(result) }, null, 2));
	console.log(`\n(json written to ${jsonOut})`);
}
