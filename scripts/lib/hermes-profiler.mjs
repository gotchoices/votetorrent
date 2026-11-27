#!/usr/bin/env node
//
// scripts/lib/hermes-profiler.mjs
//
// Purpose : the CDP capture and Metro module-index analyzer that 57-11 built in a
//           scratchpad and never committed (`57-11-PROFILE-EVIDENCE.md`, "How it was
//           captured"). The RN dev menu is unreachable on the devices this project
//           profiles (MIUI swallows the menu key), so the driver talks to Metro's CDP
//           inspector proxy directly: `GET /json/list` lists the attached runtimes,
//           and `Profiler.start` / `Profiler.stop` return a standard `.cpuprofile`
//           without ever sending `Profiler.enable` — Hermes answers that method with
//           "Unsupported method", so this file never sends it (see the one comment
//           inside `cmdCapture` that says so; that is the only place the string
//           appears).
//
//           Frames are resolved to modules by fetching the exact served dev bundle and
//           mapping each profile node's line to the enclosing Metro module footer that
//           `__d(`'s factory call closes with. The footer matcher is built from parts
//           (never written out as a literal example in this file's comments) precisely
//           so this file cannot self-trip a grep for the pattern it hunts — a defect
//           class that recurred three times in Phase 53 and is documented in
//           `.planning`'s per-session memory as "self-tripping checker headers". The
//           same discipline applies to the chunked-decode call this repo's later tasks
//           grep the served bundle for: it is never spelled out here either.
//
//           `index-bundle`'s 500-module floor and `selftest`'s mangled-footer negative
//           control exist so a collapsed or minified bundle fails LOUDLY (T-58-08-07)
//           rather than silently attributing every frame to `<unknown>`.
//
// Modes   : a CLI with subcommands (`node scripts/lib/hermes-profiler.mjs <cmd> ...`).
//           Also usable as an ESM module — every subcommand is backed by a plain,
//           side-effect-free function exported below, and `selftest` exercises those
//           functions directly rather than shelling out to itself.
//
//           preflight [--json]
//             The D-07 quiet-host reading: wall-clock timestamp, os.loadavg() (all
//             three), os.cpus().length, load-per-core, the top 8 CPU consumers by
//             percent, and whether an Android emulator is alive. REPORTS only, never
//             judges — the pass/fail threshold lives in the plan that calls this
//             (58-08 Task 3), not here. Always exits 0.
//
//           list --metro-port <p>
//             Fetches /json/list and prints every attached runtime's title,
//             description/vm and webSocketDebuggerUrl. Two runtimes are normally
//             attached; this prints both rather than guessing which one to use.
//
//           capture --metro-port <p> --target <index-or-title-substring>
//                    --out <file.cpuprofile> [--duration <s>] [--stop-on <regex>]
//             Opens the target's webSocketDebuggerUrl, starts the profiler, waits for
//             the stop condition, stops the profiler, and writes the returned
//             .cpuprofile to --out. Prints start/end timestamps and the sample count
//             so a truncated capture is visible rather than silent.
//
//           index-bundle --bundle <file|url> [--json]
//             Builds the Metro module index from a served or on-disk bundle. Exits
//             non-zero when fewer than 500 modules are indexed (MIN_MODULES below) —
//             the count is the integrity signal, not the individual answers.
//
//           analyze <file.cpuprofile> --bundle <file|url> [--top <n>]
//             Buckets self-time by module and by function, always including — even at
//             zero — the three frames this phase's D-07 comparison names: the
//             decoder's `decode`, the native `stringFromCharCode` frame, and the
//             young-generation GC frame, individually and combined.
//
//           extract-module --bundle <file|url> --match <substring>
//             Prints the source of the single Metro module whose footer path contains
//             the substring. Exits non-zero unless the match count is exactly 1 — a
//             53 MB bundle contains many unrelated call sites, so a whole-bundle grep
//             proves nothing; this is the provenance primitive that scopes the claim
//             to one module.
//
//           selftest
//             The offline gate. Synthesises a well-formed bundle (520 module
//             footers, comfortably over MIN_MODULES) and a matching synthetic
//             .cpuprofile, asserts index-bundle/analyze/extract-module/preflight all
//             behave as specified, and — per T-58-08-07 — runs a paired NEGATIVE
//             control: the same bundle with every footer's terminator deliberately
//             dropped must fail the index-bundle integrity threshold. A selftest that
//             passes against both the well-formed and the mangled bundle is not a
//             gate; this one throws if that happens.
//
// Deps    : node:fs, node:os, node:child_process, node:readline only. Zero new
//           package-manager dependencies — Node 22.15 (this repo's pinned version)
//           exposes a global `fetch` and `WebSocket`; `ws` is not resolvable in this
//           tree and must not be added (T-58-08-SC).
//
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import readline from 'node:readline';

/** Modules indexed below this floor are treated as a mangled or minified bundle. */
const MIN_MODULES = 500;

/** The exact marker Hermes/V8 cpuprofiles use for a garbage-collection sample. */
const GC_MARKER = '(garbage collector)';

// ---------------------------------------------------------------------------
// Metro module-footer index
// ---------------------------------------------------------------------------

/**
 * Builds the module-footer matcher from parts rather than as a single literal
 * example, so this file's own source never contains the pattern it hunts for
 * (self-trip discipline; T-58-08-07). In prose: a closing brace, a comma-
 * separated numeric module id, a comma-separated bracketed dependency list, a
 * comma-separated double-quoted module path, and a closing paren + semicolon
 * — the exact shape Metro emits at the end of every `__d(` factory call.
 *
 * @returns {RegExp}
 */
function buildFooterRegex() {
	const closeBrace = String.fromCharCode(0x7d); // }
	const parts = [
		closeBrace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
		',\\s*(\\d+)', // numeric module id, captured
		',\\s*\\[[^\\]]*\\]', // dependency array, not captured
		',\\s*"([^"]*)"', // double-quoted module path, captured
		'\\s*\\)\\s*;', // close-paren, semicolon, terminating the factory call
	];
	return new RegExp(parts.join(''));
}

/**
 * Scans `text` line by line for module footers. Pure function — no I/O, no
 * process-exit policy. `count < MIN_MODULES` is a CLI-level concern
 * (`indexBundleResult`/`cmdIndexBundle`), not this function's.
 *
 * @param {string} text
 * @returns {{ count: number, footers: Array<{ line: number, id: number, path: string }> }}
 */
function indexBundleText(text) {
	const re = buildFooterRegex();
	const lines = text.split('\n');
	const footers = [];
	for (let i = 0; i < lines.length; i++) {
		const m = re.exec(lines[i]);
		if (m) {
			footers.push({ line: i + 1, id: Number(m[1]), path: m[2] });
		}
	}
	return { count: footers.length, footers };
}

/**
 * The CLI-facing wrapper: same index, plus the MIN_MODULES integrity verdict.
 * Kept separate from `indexBundleText` so `selftest` can run the identical
 * logic the real `index-bundle` command exits non-zero on, without spawning
 * a subprocess and without conflating the well-formed synthetic bundle's
 * small size with the mangled-footer negative control.
 *
 * @param {string} text
 * @returns {{ count: number, footers: Array<{ line: number, id: number, path: string }>, ok: boolean }}
 */
function indexBundleResult(text) {
	const { count, footers } = indexBundleText(text);
	return { count, footers, ok: count >= MIN_MODULES };
}

/**
 * Finds the nearest following footer for a 0-based `lineNumber0based` (the
 * convention CDP `callFrame.lineNumber` uses). `footers` must be sorted
 * ascending by `.line` (1-based).
 *
 * @param {number} lineNumber0based
 * @param {Array<{ line: number, id: number, path: string }>} footers
 * @returns {{ line: number, id: number, path: string } | null}
 */
function findModuleForLine(lineNumber0based, footers) {
	const target = lineNumber0based + 1;
	for (const f of footers) {
		if (f.line >= target) return f;
	}
	return null;
}

/**
 * Extracts the source of the single module whose footer path contains
 * `substring`. Throws unless exactly one footer matches — an extractor that
 * silently returns the first hit is not a provenance instrument.
 *
 * @param {string} text
 * @param {string} substring
 * @returns {string}
 */
function extractModuleText(text, substring) {
	const lines = text.split('\n');
	const { footers } = indexBundleText(text);
	const sorted = [...footers].sort((a, b) => a.line - b.line);
	const matches = sorted.filter((f) => f.path.includes(substring));
	if (matches.length !== 1) {
		const found = matches.length > 0 ? ` (${matches.map((m) => m.path).join(', ')})` : '';
		throw new Error(
			`extract-module: expected exactly 1 module path containing "${substring}", found ${matches.length}${found}`,
		);
	}
	const target = matches[0];
	const idx = sorted.indexOf(target);
	const prevFooter = idx > 0 ? sorted[idx - 1] : null;
	const startLine0 = prevFooter ? prevFooter.line : 0; // first line after the previous footer, 0-based
	const endLine0 = target.line - 1; // the target footer's own line, 0-based, inclusive
	return lines.slice(startLine0, endLine0 + 1).join('\n');
}

// ---------------------------------------------------------------------------
// .cpuprofile analysis
// ---------------------------------------------------------------------------

/**
 * Classifies one profile node: which module and function label its self-time
 * belongs to. A node with no `callFrame.url` is native (no source file); a
 * node whose function name is the GC marker is bucketed as young-gen GC
 * regardless of url; everything else is resolved through the module index.
 *
 * @param {{ callFrame: { functionName?: string, url?: string, lineNumber?: number } }} node
 * @param {Array<{ line: number, id: number, path: string }>} sortedFooters
 * @returns {{ moduleLabel: string, functionLabel: string, kind: 'gc' | 'native' | 'js', functionName?: string }}
 */
function classifyNode(node, sortedFooters) {
	const cf = node.callFrame || {};
	const functionName = cf.functionName || '(anonymous)';
	if (functionName === GC_MARKER) {
		return { moduleLabel: '[GC Young Gen]', functionLabel: '[GC Young Gen]', kind: 'gc' };
	}
	if (!cf.url) {
		return { moduleLabel: '<native>', functionLabel: `[Native] ${functionName}`, kind: 'native' };
	}
	const footer = findModuleForLine(cf.lineNumber || 0, sortedFooters);
	const moduleLabel = footer ? footer.path : '<unknown>';
	return { moduleLabel, functionLabel: `${functionName} (${moduleLabel})`, kind: 'js', functionName };
}

/**
 * Buckets a `.cpuprofile`'s self-time by module and by function against a
 * module index, and separately tallies the three named frames every D-07
 * comparison in this phase reports — present at zero rather than omitted.
 *
 * Self-time convention: `timeDeltas[i]` is attributed to `samples[i]` (the
 * node active for that sampled interval). This is an internal convention,
 * not a claim about V8's own documented semantics; `selftest` proves it is
 * applied consistently against a synthetic fixture built the same way.
 *
 * @param {{ nodes: Array<any>, samples?: number[], timeDeltas?: number[], startTime?: number, endTime?: number }} profile
 * @param {Array<{ line: number, id: number, path: string }>} footersInput
 * @param {{ top?: number }} [options]
 */
function analyzeProfile(profile, footersInput, { top = 20 } = {}) {
	const footers = [...footersInput].sort((a, b) => a.line - b.line);
	const nodesById = new Map();
	for (const n of profile.nodes) nodesById.set(n.id, n);

	const selfUs = new Map();
	for (const n of profile.nodes) selfUs.set(n.id, 0);
	const samples = profile.samples || [];
	const timeDeltas = profile.timeDeltas || [];
	for (let i = 0; i < samples.length; i++) {
		const id = samples[i];
		const delta = timeDeltas[i] || 0;
		selfUs.set(id, (selfUs.get(id) || 0) + delta);
	}

	const totalUs =
		typeof profile.endTime === 'number' && typeof profile.startTime === 'number'
			? profile.endTime - profile.startTime
			: timeDeltas.reduce((a, b) => a + b, 0);
	const totalSeconds = totalUs / 1e6;

	const byModule = new Map();
	const byFunction = new Map();
	const named = { decode: 0, nativeStringFromCharCode: 0, gcYoungGen: 0 };

	for (const [id, us] of selfUs) {
		const node = nodesById.get(id);
		if (!node) continue;
		const seconds = us / 1e6;
		const { moduleLabel, functionLabel, kind, functionName } = classifyNode(node, footers);
		byModule.set(moduleLabel, (byModule.get(moduleLabel) || 0) + seconds);
		byFunction.set(functionLabel, (byFunction.get(functionLabel) || 0) + seconds);
		if (kind === 'js' && functionName === 'decode') named.decode += seconds;
		else if (kind === 'native' && node.callFrame.functionName === 'stringFromCharCode')
			named.nativeStringFromCharCode += seconds;
		else if (kind === 'gc') named.gcYoungGen += seconds;
	}

	const pctOf = (seconds) => (totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0);
	const toRows = (map) =>
		[...map.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([label, seconds]) => ({ label, seconds, pct: pctOf(seconds) }));

	const combinedSeconds = named.decode + named.nativeStringFromCharCode + named.gcYoungGen;

	return {
		totalSeconds,
		sampleCount: samples.length,
		byModule: toRows(byModule).slice(0, top),
		byFunction: toRows(byFunction).slice(0, top),
		named: {
			decode: { seconds: named.decode, pct: pctOf(named.decode) },
			nativeStringFromCharCode: {
				seconds: named.nativeStringFromCharCode,
				pct: pctOf(named.nativeStringFromCharCode),
			},
			gcYoungGen: { seconds: named.gcYoungGen, pct: pctOf(named.gcYoungGen) },
			combined: { seconds: combinedSeconds, pct: pctOf(combinedSeconds) },
		},
	};
}

// ---------------------------------------------------------------------------
// Host preflight (D-07 quiet-host reading)
// ---------------------------------------------------------------------------

/**
 * Top CPU consumers by percent, via `ps`. Returns `[]` on any failure rather
 * than throwing — preflight reports, it never aborts the caller.
 *
 * @param {number} [limit]
 * @returns {Array<{ pcpu: number | null, pid: number | null, comm: string }>}
 */
function getTopCpuConsumers(limit = 8) {
	try {
		const out = execSync('ps -Ao pcpu,pid,comm -r', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
		const lines = out.trim().split('\n').slice(1); // drop the header row
		return lines.slice(0, limit).map((line) => {
			const trimmed = line.trim();
			const m = trimmed.match(/^(\S+)\s+(\S+)\s+(.*)$/);
			if (!m) return { pcpu: null, pid: null, comm: trimmed };
			return { pcpu: Number(m[1]), pid: Number(m[2]), comm: m[3] };
		});
	} catch {
		return [];
	}
}

/**
 * True when an Android emulator appears to be running — either `adb devices`
 * lists an `emulator-` serial or a `qemu-system` process is alive. Both
 * checks fail closed (return false) if the underlying tool is unavailable.
 *
 * @returns {boolean}
 */
function isEmulatorAlive() {
	try {
		const devices = execSync('adb devices', { encoding: 'utf8' });
		if (/emulator-/.test(devices)) return true;
	} catch {
		// adb not installed, or failed — fall through to the qemu check.
	}
	try {
		const procs = execSync('pgrep -fl qemu-system', { encoding: 'utf8' });
		if (procs.trim().length > 0) return true;
	} catch {
		// pgrep exits non-zero when nothing matches — not alive, not an error.
	}
	return false;
}

/**
 * The D-07 quiet-host reading. Reports only — the numeric threshold that
 * judges a reading "quiet enough" is Task 3's concern, not this function's.
 *
 * @returns {{
 *   timestamp: string,
 *   loadavg: [number, number, number],
 *   cpuCount: number,
 *   loadPerCore: number | null,
 *   top: Array<{ pcpu: number | null, pid: number | null, comm: string }>,
 *   emulatorAlive: boolean,
 * }}
 */
function preflightReport() {
	const loadavg = os.loadavg();
	const cpuCount = os.cpus().length;
	const loadPerCore = cpuCount > 0 ? loadavg[0] / cpuCount : null;
	return {
		timestamp: new Date().toISOString(),
		loadavg,
		cpuCount,
		loadPerCore,
		top: getTopCpuConsumers(8),
		emulatorAlive: isEmulatorAlive(),
	};
}

// ---------------------------------------------------------------------------
// Bundle loading (file or served URL)
// ---------------------------------------------------------------------------

/**
 * @param {string} bundleArg
 * @returns {Promise<string>}
 */
async function loadBundleText(bundleArg) {
	if (/^https?:\/\//.test(bundleArg)) {
		const res = await fetch(bundleArg);
		if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${bundleArg}`);
		return res.text();
	}
	return readFileSync(bundleArg, 'utf8');
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @returns {{ opts: Record<string, string | true>, positional: string[] }}
 */
function parseArgs(args) {
	const opts = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith('--')) {
			const key = arg.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				opts[key] = next;
				i += 1;
			} else {
				opts[key] = true;
			}
		} else {
			positional.push(arg);
		}
	}
	return { opts, positional };
}

/**
 * @param {Record<string, string | true>} opts
 * @param {string} name
 * @returns {string}
 */
function requireOpt(opts, name) {
	if (opts[name] === undefined || opts[name] === true) {
		throw new Error(`missing required --${name} <value>`);
	}
	return /** @type {string} */ (opts[name]);
}

function printUsage() {
	console.error(
		[
			'usage: node scripts/lib/hermes-profiler.mjs <command> [options]',
			'',
			'commands:',
			'  preflight [--json]',
			'  list --metro-port <p>',
			'  capture --metro-port <p> --target <index-or-title-substring> --out <file.cpuprofile> [--duration <s>] [--stop-on <regex>]',
			'  index-bundle --bundle <file|url> [--json]',
			'  analyze <file.cpuprofile> --bundle <file|url> [--top <n>]',
			'  extract-module --bundle <file|url> --match <substring>',
			'  selftest',
		].join('\n'),
	);
}

// ---------------------------------------------------------------------------
// Command: preflight
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string | true>} opts
 * @returns {number}
 */
function cmdPreflight(opts) {
	const report = preflightReport();
	if (opts.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(`timestamp:     ${report.timestamp}`);
		console.log(`loadavg:       ${report.loadavg.join(', ')}`);
		console.log(`cpuCount:      ${report.cpuCount}`);
		console.log(`loadPerCore:   ${report.loadPerCore}`);
		console.log(`emulatorAlive: ${report.emulatorAlive}`);
		console.log('top CPU consumers:');
		for (const p of report.top) {
			console.log(`  ${p.pcpu}%  pid=${p.pid}  ${p.comm}`);
		}
	}
	return 0; // preflight reports; it never judges (Task 3 owns the threshold)
}

// ---------------------------------------------------------------------------
// Command: list
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string | true>} opts
 * @returns {Promise<Array<any>>}
 */
async function fetchMetroTargets(opts) {
	const port = requireOpt(opts, 'metro-port');
	const res = await fetch(`http://localhost:${port}/json/list`);
	if (!res.ok) throw new Error(`GET /json/list failed: ${res.status} ${res.statusText}`);
	return res.json();
}

/**
 * @param {Record<string, string | true>} opts
 * @returns {Promise<number>}
 */
async function cmdList(opts) {
	const targets = await fetchMetroTargets(opts);
	targets.forEach((t, i) => {
		console.log(`[${i}] ${t.title || '(untitled)'} — ${t.description || t.vm || ''}`);
		console.log(`     ${t.webSocketDebuggerUrl || '(no debugger url)'}`);
	});
	return 0;
}

/**
 * Resolves `--target` (a numeric index, or a title/description substring)
 * against the runtimes /json/list returned. Two runtimes are normally
 * attached, so an ambiguous substring is an error rather than a guess.
 *
 * @param {Array<any>} targets
 * @param {string} targetArg
 * @returns {any}
 */
function resolveTarget(targets, targetArg) {
	if (/^\d+$/.test(targetArg)) {
		const idx = Number(targetArg);
		const t = targets[idx];
		if (!t) throw new Error(`--target ${targetArg}: no runtime at that index (${targets.length} attached)`);
		return t;
	}
	const needle = targetArg.toLowerCase();
	const matches = targets.filter(
		(t) => (t.title || '').toLowerCase().includes(needle) || (t.description || '').toLowerCase().includes(needle),
	);
	if (matches.length === 0) throw new Error(`--target "${targetArg}" matched no attached runtime`);
	if (matches.length > 1) {
		throw new Error(
			`--target "${targetArg}" matched ${matches.length} attached runtimes — use an index instead ` +
				`(run "list" to see them)`,
		);
	}
	return matches[0];
}

// ---------------------------------------------------------------------------
// Command: capture
// ---------------------------------------------------------------------------

/**
 * @param {{ duration: number | null, stopOn: RegExp | null }} opts
 * @returns {Promise<void>}
 */
function waitForStop({ duration, stopOn }) {
	if (duration) {
		return new Promise((resolve) => setTimeout(resolve, duration * 1000));
	}
	if (stopOn) {
		return new Promise((resolve) => {
			const rl = readline.createInterface({ input: process.stdin });
			rl.on('line', (line) => {
				if (stopOn.test(line)) {
					rl.close();
					resolve(undefined);
				}
			});
			rl.on('close', () => resolve(undefined));
		});
	}
	throw new Error('capture requires --duration <s> or --stop-on <regex>');
}

/**
 * @param {Record<string, string | true>} opts
 * @returns {Promise<number>}
 */
async function cmdCapture(opts, deps = {}) {
	// Injection seam exists solely so selftest can drive the real start->throw->cleanup path
	// offline (no Metro, no device). Defaults ARE the production collaborators.
	const { fetchTargets = fetchMetroTargets, WebSocketImpl = WebSocket } = deps;
	const outPath = requireOpt(opts, 'out');
	const targetArg = requireOpt(opts, 'target');
	const duration = opts.duration && opts.duration !== true ? Number(opts.duration) : null;
	const stopOn = opts['stop-on'] && opts['stop-on'] !== true ? new RegExp(/** @type {string} */ (opts['stop-on'])) : null;

	const targets = await fetchTargets(opts);
	const target = resolveTarget(targets, targetArg);
	if (!target.webSocketDebuggerUrl) throw new Error('resolved target has no webSocketDebuggerUrl');

	const ws = new WebSocketImpl(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(undefined));
		ws.addEventListener('error', (ev) => reject(new Error(`WebSocket error: ${ev.message || ev}`)));
	});

	let nextId = 1;
	/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
	const pending = new Map();
	ws.addEventListener('message', (ev) => {
		let msg;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			return;
		}
		if (msg.id != null && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(`CDP error for id ${msg.id}: ${JSON.stringify(msg.error)}`));
			else resolve(msg.result);
		}
	});

	/**
	 * @param {string} method
	 * @param {Record<string, unknown>} [params]
	 * @returns {Promise<any>}
	 */
	function send(method, params = {}) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	// Never send Profiler.enable here — Hermes answers it with "Unsupported
	// method" (57-11-PROFILE-EVIDENCE.md). Profiler.start / Profiler.stop work
	// directly, without it.
	const startedAt = new Date().toISOString();
	await send('Profiler.start');

	// Once Profiler.start succeeds the device is profiling, so every exit path from here
	// must close the socket -- otherwise a throw between start and stop (e.g. neither
	// --duration nor --stop-on given) leaks the WebSocket AND leaves the device profiler
	// running, which silently taints the next capture.
	let stopResult;
	let endedAt;
	try {
		await waitForStop({ duration, stopOn });
		stopResult = await send('Profiler.stop');
		endedAt = new Date().toISOString();
	} finally {
		try {
			ws.close();
		} catch {
			/* socket already torn down -- nothing to reclaim */
		}
	}

	const profile = stopResult && stopResult.profile;
	if (!profile || !Array.isArray(profile.samples)) {
		throw new Error('Profiler.stop did not return a usable .cpuprofile (missing samples array)');
	}
	writeFileSync(outPath, JSON.stringify(profile));
	console.log(`capture start: ${startedAt}`);
	console.log(`capture end:   ${endedAt}`);
	console.log(`sample count:  ${profile.samples.length}`);
	console.log(`written:       ${outPath}`);
	return 0;
}

// ---------------------------------------------------------------------------
// Command: index-bundle
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string | true>} opts
 * @returns {Promise<number>}
 */
async function cmdIndexBundle(opts) {
	const bundleArg = requireOpt(opts, 'bundle');
	const text = await loadBundleText(bundleArg);
	const result = indexBundleResult(text);
	if (opts.json) {
		console.log(JSON.stringify({ count: result.count, footers: result.footers }));
	} else {
		console.log(`indexed ${result.count} module footers from ${bundleArg}`);
	}
	if (!result.ok) {
		console.error(
			`index-bundle: only ${result.count} module footers found (minimum ${MIN_MODULES}) — ` +
				`treating this as a mangled or minified bundle`,
		);
		return 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Command: analyze
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof analyzeProfile>} result
 */
function printAnalysis(result) {
	console.log(`capture duration: ${result.totalSeconds.toFixed(1)} s`);
	console.log(`sample count:     ${result.sampleCount}`);
	console.log('');
	console.log('Self time by MODULE:');
	for (const row of result.byModule) {
		console.log(`  ${row.seconds.toFixed(1)}s  ${row.pct.toFixed(1)}%  ${row.label}`);
	}
	console.log('');
	console.log('Self time by FUNCTION:');
	for (const row of result.byFunction) {
		console.log(`  ${row.seconds.toFixed(1)}s  ${row.pct.toFixed(1)}%  ${row.label}`);
	}
	console.log('');
	console.log('Named frames (always reported, even at zero):');
	console.log(`  decode:                      ${result.named.decode.seconds.toFixed(1)}s  ${result.named.decode.pct.toFixed(1)}%`);
	console.log(
		`  [Native] stringFromCharCode: ${result.named.nativeStringFromCharCode.seconds.toFixed(1)}s  ${result.named.nativeStringFromCharCode.pct.toFixed(1)}%`,
	);
	console.log(`  [GC Young Gen]:              ${result.named.gcYoungGen.seconds.toFixed(1)}s  ${result.named.gcYoungGen.pct.toFixed(1)}%`);
	console.log(`  combined:                    ${result.named.combined.seconds.toFixed(1)}s  ${result.named.combined.pct.toFixed(1)}%`);
}

/**
 * @param {Record<string, string | true>} opts
 * @param {string[]} positional
 * @returns {Promise<number>}
 */
async function cmdAnalyze(opts, positional) {
	const profilePath = positional[0];
	if (!profilePath) throw new Error('analyze requires a <file.cpuprofile> positional argument');
	const bundleArg = requireOpt(opts, 'bundle');
	const top = opts.top && opts.top !== true ? Number(opts.top) : 20;
	const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
	const bundleText = await loadBundleText(bundleArg);
	const { footers } = indexBundleText(bundleText);
	const result = analyzeProfile(profile, footers, { top });
	printAnalysis(result);
	return 0;
}

// ---------------------------------------------------------------------------
// Command: extract-module
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string | true>} opts
 * @returns {Promise<number>}
 */
async function cmdExtractModule(opts) {
	const bundleArg = requireOpt(opts, 'bundle');
	const match = requireOpt(opts, 'match');
	const text = await loadBundleText(bundleArg);
	const body = extractModuleText(text, match); // throws on 0 or >1 matches
	console.log(body);
	return 0;
}

// ---------------------------------------------------------------------------
// Command: selftest
// ---------------------------------------------------------------------------

let assertionCount = 0;

/** @param {unknown} actual @param {unknown} expected @param {string} label */
function assertEqual(actual, expected, label) {
	assertionCount += 1;
	if (actual !== expected) {
		throw new Error(`selftest FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

/** @param {unknown} value @param {string} label */
function assertTruthy(value, label) {
	assertionCount += 1;
	if (!value) throw new Error(`selftest FAILED [${label}]`);
}

/** @param {number} actual @param {number} expected @param {string} label @param {number} [epsilon] */
function assertClose(actual, expected, label, epsilon = 1e-6) {
	assertionCount += 1;
	if (Math.abs(actual - expected) > epsilon) {
		throw new Error(`selftest FAILED [${label}]: expected ~${expected}, got ${actual}`);
	}
}

/** @param {() => void} fn @param {string} label */
function assertThrows(fn, label) {
	assertionCount += 1;
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	if (!threw) throw new Error(`selftest FAILED [${label}]: expected a throw, none occurred`);
}

/**
 * Builds one well-formed footer line. A CODE-level construction, not a
 * comment — the self-trip discipline this file follows concerns comments
 * describing the pattern, not the synthetic fixtures that exercise it.
 *
 * @param {number} id
 * @param {number[]} deps
 * @param {string} path
 * @returns {string}
 */
function makeFooter(id, deps, path) {
	return `}, ${id}, [${deps.join(',')}], "${path}");`;
}

const SELFTEST_DECODER_PATH = 'apps/VoteTorrentAuthority/polyfills/hermes-text-decoder.js';
const SELFTEST_GENERIC_PATH = 'packages/vote-engine/src/database/initialize.js';
const SELFTEST_AMBIGUOUS_SUBSTRING = 'shared-widget-';
const SELFTEST_WELL_FORMED_COUNT = 520; // comfortably over MIN_MODULES

/**
 * @returns {{ text: string, count: number }}
 */
function buildSelftestBundle() {
	const lines = [];
	for (let i = 0; i < SELFTEST_WELL_FORMED_COUNT; i++) {
		let modulePath;
		if (i === 10) modulePath = SELFTEST_DECODER_PATH;
		else if (i === 20) modulePath = SELFTEST_GENERIC_PATH;
		else if (i === 30) modulePath = `apps/VoteTorrentAuthority/${SELFTEST_AMBIGUOUS_SUBSTRING}alpha.js`;
		else if (i === 31) modulePath = `apps/VoteTorrentVoter/${SELFTEST_AMBIGUOUS_SUBSTRING}beta.js`;
		else modulePath = `node_modules/synthetic-pkg-${i}/index.js`;
		lines.push(`function syntheticBody_${i}() { return ${i}; }`);
		lines.push(makeFooter(i, i > 0 ? [i - 1] : [], modulePath));
	}
	return { text: lines.join('\n'), count: SELFTEST_WELL_FORMED_COUNT };
}

/**
 * Deliberately drops every footer's terminating punctuation, so the negative
 * control proves the matcher requires the exact terminator rather than
 * loosely matching nearby text (T-58-08-07).
 *
 * @param {string} text
 * @returns {string}
 */
function mangleFooters(text) {
	const footerRe = buildFooterRegex();
	return text
		.split('\n')
		.map((line) => (footerRe.test(line) ? line.slice(0, -2) : line))
		.join('\n');
}

/** @param {{ line: number, id: number, path: string }} footer @returns {number} */
function bodyLineFor(footer) {
	return footer.line - 2; // 0-based line immediately above the footer
}

/**
 * @returns {number}
 */
async function cmdSelftest() {
	const built = buildSelftestBundle();
	const indexed = indexBundleText(built.text);
	assertEqual(indexed.count, built.count, 'index-bundle count matches the synthesised footer count');

	const decoderFooter = indexed.footers.find((f) => f.path === SELFTEST_DECODER_PATH);
	const genericFooter = indexed.footers.find((f) => f.path === SELFTEST_GENERIC_PATH);
	assertTruthy(decoderFooter, 'decoder module footer indexed');
	assertTruthy(genericFooter, 'generic module footer indexed');

	const profile = {
		startTime: 0,
		endTime: 3300,
		nodes: [
			{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } },
			{ id: 2, callFrame: { functionName: 'decode', url: 'synthetic-bundle', lineNumber: bodyLineFor(decoderFooter) } },
			{ id: 3, callFrame: { functionName: 'stringFromCharCode', url: '', lineNumber: 0 } },
			{ id: 4, callFrame: { functionName: GC_MARKER, url: '', lineNumber: 0 } },
			{ id: 5, callFrame: { functionName: 'syntheticGenericFn', url: 'synthetic-bundle', lineNumber: bodyLineFor(genericFooter) } },
		],
		samples: [1, 2, 2, 2, 3, 3, 4, 5, 5, 2],
		timeDeltas: [100, 200, 200, 200, 300, 300, 400, 500, 500, 600],
	};

	const analyzed = analyzeProfile(profile, indexed.footers, { top: 10 });
	assertClose(analyzed.named.decode.seconds, 0.0012, 'decode self-time attributed correctly');
	assertClose(analyzed.named.nativeStringFromCharCode.seconds, 0.0006, 'native stringFromCharCode self-time attributed correctly');
	assertClose(analyzed.named.gcYoungGen.seconds, 0.0004, 'GC young-gen self-time attributed correctly');

	const decoderModuleRow = analyzed.byModule.find((r) => r.label === SELFTEST_DECODER_PATH);
	assertTruthy(decoderModuleRow, 'decode self-time attributed to the decoder MODULE');
	assertClose(decoderModuleRow.seconds, 0.0012, 'decoder module self-time value');

	const decoderFunctionRow = analyzed.byFunction.find((r) => r.label === `decode (${SELFTEST_DECODER_PATH})`);
	assertTruthy(decoderFunctionRow, 'decode self-time attributed to the decode FUNCTION');

	const decoderBody = extractModuleText(built.text, 'hermes-text-decoder');
	assertTruthy(decoderBody.includes('syntheticBody_10'), 'extract-module returns exactly the intended module body');
	assertThrows(() => extractModuleText(built.text, 'no-such-module-substring-zzz'), 'extract-module throws on a zero-match substring');
	assertThrows(() => extractModuleText(built.text, SELFTEST_AMBIGUOUS_SUBSTRING), 'extract-module throws on an ambiguous two-match substring');

	const pf = preflightReport();
	assertTruthy(Array.isArray(pf.loadavg) && pf.loadavg.length === 3, 'preflight loadavg is a 3-tuple');
	assertTruthy(typeof pf.cpuCount === 'number' && pf.cpuCount > 0, 'preflight cpuCount is a positive number');
	assertTruthy(Array.isArray(pf.top) && pf.top.length > 0, 'preflight top is a non-empty array');
	assertTruthy(typeof pf.emulatorAlive === 'boolean', 'preflight emulatorAlive is a boolean');

	const wellFormedResult = indexBundleResult(built.text);
	assertTruthy(wellFormedResult.ok, 'well-formed synthetic bundle passes the index-bundle integrity threshold');

	const mangledText = mangleFooters(built.text);
	const mangledResult = indexBundleResult(mangledText);
	if (mangledResult.ok) {
		throw new Error(
			'selftest FAILED [mangled-footer negative control]: index-bundle PASSED against a deliberately ' +
				'mangled bundle — the footer matcher is inert (T-58-08-07)',
		);
	}
	assertionCount += 1;
	console.log(
		`NEGATIVE CONTROL (mangled footers): well-formed index-bundle ok=true (count=${wellFormedResult.count}); ` +
			`mangled index-bundle ok=false (count=${mangledResult.count}) — exited NON-ZERO as required. PASS.`,
	);

	// Resource guard for cmdCapture (58-REVIEW Warning 2). Once Profiler.start succeeds the
	// DEVICE is profiling, so a throw before Profiler.stop must still close the socket -- otherwise
	// the next capture is silently taken against an already-running profiler. Drives the exact
	// reachable case the review named: neither --duration nor --stop-on, which makes the real
	// waitForStop throw. Injects only the socket and the target list; every other collaborator,
	// including waitForStop itself, is the production one.
	const captureCloses = [];
	class SelftestSocket {
		constructor(url) {
			this.url = url;
			this.handlers = {};
			queueMicrotask(() => this.emit('open'));
		}
		addEventListener(type, fn) {
			(this.handlers[type] = this.handlers[type] || []).push(fn);
		}
		emit(type, ev) {
			for (const fn of this.handlers[type] || []) fn(ev);
		}
		send(raw) {
			const msg = JSON.parse(raw);
			queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) }));
		}
		close() {
			captureCloses.push(this.url);
		}
	}
	const selftestDeps = {
		fetchTargets: async () => [{ title: 'selftest-runtime', webSocketDebuggerUrl: 'ws://selftest/invalid' }],
		WebSocketImpl: SelftestSocket,
	};
	let captureThrew = false;
	try {
		await cmdCapture({ out: '/dev/null', target: 'selftest-runtime' }, selftestDeps);
	} catch {
		captureThrew = true;
	}
	assertTruthy(captureThrew, 'capture propagates the no-duration/no-stop-on error');
	if (captureCloses.length !== 1) {
		throw new Error(
			'selftest FAILED [capture cleanup guard]: Profiler.start succeeded and then capture threw, ' +
				`but ws.close() ran ${captureCloses.length} time(s) instead of once — the socket leaks and ` +
				'the device profiler is left running (58-REVIEW Warning 2)',
		);
	}
	assertionCount += 1;
	console.log(
		'CLEANUP GUARD (capture): Profiler.start then throw — ws.close() ran exactly once. PASS.',
	);

	console.log(`selftest: ${assertionCount} assertions passed.`);
	return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
	const [, , command, ...rest] = process.argv;
	const { opts, positional } = parseArgs(rest);
	try {
		let code = 0;
		switch (command) {
			case 'preflight':
				code = cmdPreflight(opts);
				break;
			case 'list':
				code = await cmdList(opts);
				break;
			case 'capture':
				code = await cmdCapture(opts);
				break;
			case 'index-bundle':
				code = await cmdIndexBundle(opts);
				break;
			case 'analyze':
				code = await cmdAnalyze(opts, positional);
				break;
			case 'extract-module':
				code = await cmdExtractModule(opts);
				break;
			case 'selftest':
				code = await cmdSelftest();
				break;
			default:
				printUsage();
				code = command ? 1 : 0;
		}
		process.exitCode = code || 0;
	} catch (err) {
		console.error(`hermes-profiler: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

main();
