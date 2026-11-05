#!/usr/bin/env node
/**
 * rkstorage-staged-probe.mjs — host-side probe of a PULLED RKStorage database.
 *
 * WHY A HOST-SIDE PROBE AT ALL. The staged sign-in-code record is a row in the
 * app's AsyncStorage-backed sqlite file. Reading it from inside the app would
 * route through `readStagedSignInCode`, whose documented contract is that its
 * result NEVER carries `snapshotJson` — which is the exact field the legacy
 * cleanup leg exists to look for. Asking the app is therefore structurally
 * incapable of answering the question. The database is pulled with `run-as` and
 * inspected here, off the device, by a second implementation.
 *
 * WHAT IT REFUSES TO GUESS. It never parses the sqlite file format itself; it
 * spawns the host `sqlite3` binary and fails with a named error if there is
 * none. A pulled file that sqlite3 cannot open is an error, never a "clean"
 * reading — an unreadable database and an empty one are not the same
 * observation, and conflating them would make every downstream verdict vacuous.
 *
 * Modes
 *   --db <path> --canary <token>
 *       Read-back probe. Emits ONE compact JSON object on stdout describing
 *       what was seen. Exits 0 for "absent", for "present and clean" and for
 *       "present and carrying a payload" alike: reporting is this mode's whole
 *       job, and the CALLER decides what the observation means.
 *
 *   --make-legacy <outfile> --canary <token> --expires <19-char canonical>
 *       Synthesize a pre-fix-shaped record — the shipped live-record field set
 *       PLUS a `snapshotJson` string carrying the canary — and write it to
 *       <outfile>, ready to be loaded with sqlite3's readfile(). The field
 *       names are READ OUT OF the shipped source, not retyped here, and a
 *       drift between the two is a named failure rather than a silent
 *       divergence.
 *
 *   --assert-clean <path> --canary <token>
 *       The gating mode. Exits 0 only when all three conditions hold:
 *         (1) the staged record is absent, or present with no `snapshotJson`;
 *         (2) the live-row canary count is 0;
 *         (3) the live-row `snapshotJson` count is 0.
 *       On failure it names WHICH of the three failed.
 *
 *   --selftest
 *       Builds a throwaway database and runs a POSITIVE control (a synthesized
 *       legacy record must be DETECTED and must be REFUSED by --assert-clean)
 *       and a NEGATIVE control (a tombstone must read clean and must be
 *       ACCEPTED). A probe that answered "clean" unconditionally would pass the
 *       negative case and fail the positive one, so it cannot pass this.
 *
 * Dependencies: node: builtins plus a spawned host `sqlite3`. No npm package.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/** The one key this probe knows about (`dashboard-signin-code.ts:148`). */
const STAGED_KEY = "votetorrent.dashboardBootstrap.stagedCode";
/** The table React Native's AsyncStorage backend writes into. */
const TABLE = "catalystLocalStorage";
/** The shipped source the live-record field set is read out of. */
const RECORD_SOURCE = join(
	REPO_ROOT,
	"apps/VoteTorrentAuthority/src/services/dashboard-signin-code.ts",
);
/**
 * The field set this probe was written against. It is NOT the source of truth —
 * the shipped file is — but a mismatch between the two means the record shape
 * moved, and a synthesized "pre-fix" record built from the wrong field set
 * would resemble nothing. So the drift is reported rather than absorbed.
 */
const EXPECTED_LIVE_FIELDS = [
	"code",
	"digest",
	"expiresAt",
	"lookupId",
	"mintedAt",
	"secret",
	"snapshotName",
];
/**
 * The measured size of the payload a real pre-fix record carried, so an
 * injected case resembles the organic one it stands in for rather than being a
 * token stub.
 */
const ORGANIC_PAYLOAD_BYTES = 4689;

// ---------------------------------------------------------------------------
// sqlite3 plumbing
// ---------------------------------------------------------------------------

class ProbeError extends Error {
	constructor(name, message) {
		super(message);
		this.name = name;
	}
}

let cachedSqlite;
function sqliteBin() {
	if (cachedSqlite !== undefined) return cachedSqlite;
	const probe = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new ProbeError(
			"sqlite3-missing",
			"no usable `sqlite3` on PATH. This probe deliberately does not parse the sqlite " +
				"file format itself, so there is no fallback. Install it (macOS: it ships with " +
				"the Android platform-tools, or `brew install sqlite`) and re-run.",
		);
	}
	cachedSqlite = "sqlite3";
	return cachedSqlite;
}

function sqlite(dbPath, ...args) {
	const run = spawnSync(sqliteBin(), [dbPath, ...args], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (run.error) {
		throw new ProbeError("sqlite3-spawn-failed", `sqlite3 could not be executed: ${run.error.message}`);
	}
	if (run.status !== 0) {
		throw new ProbeError(
			"sqlite3-refused",
			`sqlite3 refused ${dbPath} (exit ${run.status}): ${String(run.stderr).trim()}`,
		);
	}
	return String(run.stdout);
}

/** Single scalar, trimmed. Empty string when the query returned no row. */
function scalar(dbPath, statement) {
	return sqlite(dbPath, statement).trim();
}

/** Occurrence count — NOT a matching-line count, which under-reports two hits on one line. */
function countOccurrences(haystack, needle) {
	if (!needle) return 0;
	return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// mode: --db (read-back probe)
// ---------------------------------------------------------------------------

function probe(dbPath, canary) {
	if (!existsSync(dbPath)) {
		throw new ProbeError("db-missing", `no such database: ${dbPath}`);
	}
	const fileBytes = statSync(dbPath).size;
	if (fileBytes === 0) {
		throw new ProbeError(
			"db-empty",
			`${dbPath} is zero bytes. A pull that produced nothing is NOT a clean device — it is ` +
				"a failed pull. Check that the build is debuggable (`run-as` must exit 0) and that " +
				"the app has been launched at least once.",
		);
	}

	// Openability first. A truncated or CRLF-mangled pull must be an ERROR, not a
	// silently empty reading: `adb shell "run-as PKG cat databases/RKStorage"` is
	// the pull idiom in use, and on some platform-tools builds a shell channel can
	// still mangle binary. `adb exec-out` is the remedy to try next.
	let tables;
	try {
		tables = sqlite(dbPath, "select name from sqlite_master where type='table';");
	} catch (err) {
		throw new ProbeError(
			"db-unusable",
			`${dbPath} could not be opened as a sqlite database (${err.message}). If it was pulled ` +
				'with `adb shell "run-as PKG cat …"`, retry the pull with `adb exec-out run-as PKG ' +
				"cat …` — a shell channel can mangle binary bytes on some platform-tools builds.",
		);
	}
	if (!tables.split("\n").map((t) => t.trim()).includes(TABLE)) {
		throw new ProbeError(
			"table-missing",
			`${dbPath} has no ${TABLE} table (tables: ${tables.split("\n").filter(Boolean).join(", ") || "none"}). ` +
				"This is not the app's RKStorage database.",
		);
	}

	const rowCount = Number(scalar(dbPath, `select count(*) from ${TABLE};`) || "0");
	const hex = scalar(dbPath, `select hex(value) from ${TABLE} where key='${STAGED_KEY}';`);
	const present = hex.length > 0;

	let byteLength = 0;
	let keys = null;
	let parseError = null;
	let hasSnapshotJson = false;
	if (present) {
		const buf = Buffer.from(hex, "hex");
		byteLength = buf.length;
		try {
			const parsed = JSON.parse(buf.toString("utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				keys = Object.keys(parsed).sort();
				hasSnapshotJson = keys.includes("snapshotJson");
			} else {
				parseError = "value parsed as JSON but is not a record object";
			}
		} catch (err) {
			parseError = `value is not parseable JSON: ${err.message}`;
		}
	}

	// The whole-file scan, over `.dump` — i.e. over LIVE ROWS. A canary that
	// survives only in a freed page is reported separately below and is
	// deliberately NOT part of the verdict: sqlite does not zero freed pages, so
	// gating on raw bytes would make a correct tombstone read as a failure.
	const dump = sqlite(dbPath, ".dump");
	const canaryHits = countOccurrences(dump, canary);
	const snapshotJsonHitsWholeFile = countOccurrences(dump, "snapshotJson");

	const rawFile = readFileSync(dbPath).toString("latin1");
	const canaryHitsRawFile = countOccurrences(rawFile, canary);

	return {
		db: dbPath,
		fileBytes,
		rowCount,
		key: STAGED_KEY,
		present,
		byteLength,
		keys,
		parseError,
		hasSnapshotJson,
		canary,
		canaryHits,
		snapshotJsonHitsWholeFile,
		// Informational only — see the comment above. Non-zero here with
		// canaryHits 0 means "logically gone, bytes still on the disk image".
		canaryHitsRawFile,
	};
}

// ---------------------------------------------------------------------------
// mode: --make-legacy (synthesis)
// ---------------------------------------------------------------------------

/** Read the live-record field set out of the shipped source rather than retyping it. */
function liveRecordFields() {
	if (!existsSync(RECORD_SOURCE)) {
		throw new ProbeError(
			"record-source-missing",
			`cannot read the live-record field set: ${RECORD_SOURCE} does not exist. The synthesized ` +
				"record's shape is derived from the shipped source on purpose — inventing it would " +
				"produce a fixture that resembles nothing.",
		);
	}
	const source = readFileSync(RECORD_SOURCE, "utf8");
	const block = source.match(/const persisted: PersistedStagedRecord = \{([\s\S]*?)\n\t*\};/);
	if (!block) {
		throw new ProbeError(
			"record-shape-unreadable",
			"could not locate the `const persisted: PersistedStagedRecord = { … }` literal in " +
				`${RECORD_SOURCE}. The persisted-record construction moved or changed shape; this ` +
				"probe must be updated deliberately, not left guessing.",
		);
	}
	const fields = [];
	for (const line of block[1].split("\n")) {
		const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[,:]/);
		if (m) fields.push(m[1]);
	}
	const sorted = [...new Set(fields)].sort();
	if (sorted.length === 0) {
		throw new ProbeError("record-shape-empty", "the persisted-record literal yielded no field names");
	}
	const drift =
		sorted.length !== EXPECTED_LIVE_FIELDS.length ||
		sorted.some((f, i) => f !== EXPECTED_LIVE_FIELDS[i]);
	return { fields: sorted, drift };
}

function canonicalNow() {
	return new Date().toISOString().slice(0, 19);
}

function assertCanonicalPastDatetime(value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new ProbeError("expires-missing", "--expires is required and takes a 19-character value");
	}
	if (value.endsWith("Z")) {
		throw new ProbeError(
			"expires-trailing-z",
			`--expires '${value}' carries a trailing 'Z'. The canonical form is 19 characters with NO ` +
				"'Z'. This is REJECTED rather than stripped on purpose: the normaliser used elsewhere " +
				"in the app strips it silently, which makes a caller that passes the wrong shape look " +
				"correct. A fixture generator is not a normaliser.",
		);
	}
	if (value.length !== 19 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
		throw new ProbeError(
			"expires-not-canonical",
			`--expires '${value}' is not the canonical 19-character YYYY-MM-DDTHH:MM:SS form.`,
		);
	}
	// Compared as raw strings, never through Date.parse — the same discipline the
	// shipped code follows for these values.
	if (!(value < canonicalNow())) {
		throw new ProbeError(
			"expires-not-past",
			`--expires '${value}' is not in the past (now ${canonicalNow()}). The record being ` +
				"synthesized stands in for residue that outlived its own expiry; a future expiry " +
				"would be a live code, which is a different thing entirely.",
		);
	}
	return value;
}

function minus(canonical, minutes) {
	return new Date(new Date(`${canonical}Z`).getTime() - minutes * 60_000).toISOString().slice(0, 19);
}

/** Deterministic filler so a synthesized record is reproducible across runs. */
function derived(seed, label, length, alphabet) {
	let out = "";
	let counter = 0;
	while (out.length < length) {
		const h = createHash("sha256").update(`${seed}:${label}:${counter}`).digest();
		for (const b of h) {
			out += alphabet[b % alphabet.length];
			if (out.length >= length) break;
		}
		counter += 1;
	}
	return out;
}

const HEX = "0123456789abcdef";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function synthesizeLegacyRecord(canary, expiresAt) {
	assertCanonicalPastDatetime(expiresAt);
	const { fields, drift } = liveRecordFields();
	const seed = `${canary}|${expiresAt}`;

	const secret = derived(seed, "secret", 40, HEX);
	const digest = derived(seed, "digest", 43, B64URL);
	const values = {
		code: `${secret}.${digest}`,
		secret,
		digest,
		lookupId: derived(seed, "lookupId", 43, B64URL),
		expiresAt,
		mintedAt: minus(expiresAt, 10),
		snapshotName: `snapshot-${secret.slice(0, 16)}`,
	};

	const record = {};
	for (const field of fields) {
		if (!(field in values)) {
			throw new ProbeError(
				"record-field-unknown",
				`the shipped persisted-record literal names a field this probe cannot synthesize: ` +
					`'${field}'. Add a value for it deliberately rather than emitting a record that is ` +
					"missing a field the app writes.",
			);
		}
		record[field] = values[field];
	}

	// The payload. Shaped like the organic residue that was measured — a
	// format marker, a schema hash and populated table rows — and carrying the
	// canary so a whole-file scan can find it unambiguously.
	const payload = {
		formatVersion: 1,
		schemaHash: derived(seed, "schemaHash", 64, HEX),
		canary,
		tables: {
			Authority: [{ Sid: derived(seed, "authority", 32, HEX), Name: `${canary}-authority` }],
			Network: [{ Sid: derived(seed, "network", 32, HEX), Name: `${canary}-network` }],
			Registrant: [{ Sid: derived(seed, "registrant", 32, HEX), Name: `${canary}-registrant` }],
			User: [{ Sid: derived(seed, "user", 32, HEX), Name: `${canary}-user` }],
		},
		filler: "",
	};
	// Pad to the measured organic size exactly, so the injected case is the same
	// order of magnitude as the residue it stands in for and the byte length in
	// the evidence file is a number with a provenance.
	const withoutFiller = JSON.stringify(payload).length;
	const deficit = ORGANIC_PAYLOAD_BYTES - withoutFiller;
	payload.filler = deficit > 0 ? derived(seed, "filler", deficit, HEX) : "";
	record.snapshotJson = JSON.stringify(payload);

	return { record, fields, drift, snapshotJsonBytes: record.snapshotJson.length };
}

// ---------------------------------------------------------------------------
// mode: --assert-clean
// ---------------------------------------------------------------------------

function assertClean(dbPath, canary) {
	const observed = probe(dbPath, canary);
	const failures = [];
	if (observed.present && observed.hasSnapshotJson) {
		failures.push(
			`condition 1 (record shape): the staged record is present and STILL CARRIES snapshotJson ` +
				`(${observed.byteLength} bytes, keys ${JSON.stringify(observed.keys)})`,
		);
	}
	if (observed.present && observed.parseError !== null) {
		failures.push(`condition 1 (record shape): ${observed.parseError}`);
	}
	if (observed.canaryHits !== 0) {
		failures.push(
			`condition 2 (whole-file canary): '${canary}' still appears ${observed.canaryHits} time(s) ` +
				"in the live rows",
		);
	}
	if (observed.snapshotJsonHitsWholeFile !== 0) {
		failures.push(
			`condition 3 (whole-file snapshotJson): 'snapshotJson' still appears ` +
				`${observed.snapshotJsonHitsWholeFile} time(s) in the live rows`,
		);
	}
	return { observed, failures };
}

// ---------------------------------------------------------------------------
// mode: --selftest
// ---------------------------------------------------------------------------

function loadRecordIntoDb(dbPath, recordJson, workDir) {
	const valueFile = join(workDir, "value.json");
	writeFileSync(valueFile, recordJson);
	// CAST(... AS TEXT): readfile() yields a BLOB, and the app writes TEXT. A BLOB
	// column value changes what length() means and is not what the app would read
	// back, so the cast is load-bearing, not cosmetic. This is the same statement
	// the rig's inject path uses.
	sqlite(
		dbPath,
		`insert or replace into ${TABLE}(key, value) values('${STAGED_KEY}', CAST(readfile('${valueFile}') AS TEXT));`,
	);
}

function selftest() {
	const canary = "legacy-staged-residue-canary";
	const expiresAt = "2026-01-02T03:04:05";
	const work = mkdtempSync(join(tmpdir(), "rkstorage-selftest-"));
	const dbPath = join(work, "RKStorage");
	const problems = [];

	const say = (line) => process.stdout.write(`[staged-probe selftest] ${line}\n`);

	try {
		// The real schema, copied from a pulled device database.
		sqlite(dbPath, "create table android_metadata (locale TEXT);");
		sqlite(dbPath, `create table ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
		sqlite(dbPath, "insert into catalystLocalStorage(key, value) values('deviceUser', '{\"id\":\"selftest\"}');");

		// ---- POSITIVE CONTROL: a legacy record must be DETECTED and REFUSED ----
		const synth = synthesizeLegacyRecord(canary, expiresAt);
		if (synth.drift) {
			say(
				`NOTE: the shipped persisted-record field set is ${JSON.stringify(synth.fields)}, which ` +
					`differs from the set this probe was written against ${JSON.stringify(EXPECTED_LIVE_FIELDS)}`,
			);
		}
		loadRecordIntoDb(dbPath, JSON.stringify(synth.record), work);

		const positive = probe(dbPath, canary);
		say(`POSITIVE case — synthesized pre-fix record loaded (${positive.byteLength} bytes)`);
		say(`  ${JSON.stringify(positive)}`);
		if (!positive.present) problems.push("positive: the record was not present after loading it");
		if (!positive.hasSnapshotJson) {
			problems.push("positive: hasSnapshotJson is false — the legacy payload was NOT detected");
		}
		if (!(positive.canaryHits > 0)) {
			problems.push(`positive: canaryHits is ${positive.canaryHits} — expected greater than 0`);
		}
		if (positive.snapshotJsonHitsWholeFile < 1) {
			problems.push("positive: snapshotJsonHitsWholeFile is 0 — the whole-file scan saw nothing");
		}
		const positiveVerdict = assertClean(dbPath, canary);
		say(`  --assert-clean refused with ${positiveVerdict.failures.length} condition failure(s):`);
		for (const f of positiveVerdict.failures) say(`    ${f}`);
		if (positiveVerdict.failures.length === 0) {
			problems.push("positive: --assert-clean ACCEPTED a record carrying a legacy payload");
		} else if (!positiveVerdict.failures.some((f) => f.includes("snapshotJson"))) {
			problems.push("positive: --assert-clean refused, but not for the snapshotJson condition");
		}
		// Each condition must be proven load-bearing ON ITS OWN. Asserting only
		// "it refused" is too weak: conditions 1 and 3 both key off the literal
		// 'snapshotJson', so disabling condition 2 -- the whole-file canary --
		// left the verdict unchanged and this selftest green. The canary is the
		// only condition that catches a payload which moved to a different key
		// or lingers in a freed page, which is the residue class this leg
		// exists to detect. Require all three to fire against the positive
		// fixture, so silently breaking any one of them turns the gate red.
		for (const condition of ["condition 1", "condition 2", "condition 3"]) {
			if (!positiveVerdict.failures.some((f) => f.startsWith(condition))) {
				problems.push(
					`positive: ${condition} did not fire against the legacy fixture — ` +
						"it is not load-bearing and could be removed unnoticed",
				);
			}
		}

		// ---- NEGATIVE CONTROL: a tombstone must read clean and be ACCEPTED ----
		// The tombstone shape the shipped sweep writes: the payload and the
		// snapshot name are both gone, the fact of the code survives.
		const tombstone = {
			code: synth.record.code,
			secret: synth.record.secret,
			digest: synth.record.digest,
			expiresAt: synth.record.expiresAt,
			mintedAt: synth.record.mintedAt,
			lookupId: synth.record.lookupId,
		};
		loadRecordIntoDb(dbPath, JSON.stringify(tombstone), work);
		// The freed page still holds the old bytes; VACUUM makes the negative
		// control measure the LIVE rows only, which is what the verdict is about.
		sqlite(dbPath, "vacuum;");

		const negative = probe(dbPath, canary);
		say(`NEGATIVE case — tombstone loaded (${negative.byteLength} bytes)`);
		say(`  ${JSON.stringify(negative)}`);
		if (!negative.present) problems.push("negative: the tombstone was not present after loading it");
		if (negative.hasSnapshotJson) {
			problems.push("negative: hasSnapshotJson is true on a tombstone");
		}
		if (negative.canaryHits !== 0) {
			problems.push(`negative: canaryHits is ${negative.canaryHits} — expected 0`);
		}
		const negativeVerdict = assertClean(dbPath, canary);
		say(`  --assert-clean accepted: ${negativeVerdict.failures.length === 0}`);
		for (const f of negativeVerdict.failures) say(`    ${f}`);
		if (negativeVerdict.failures.length !== 0) {
			problems.push("negative: --assert-clean REFUSED a clean tombstone");
		}

		// ---- NEGATIVE CONTROL 2: an absent record is clean, not an error ----
		sqlite(dbPath, `delete from ${TABLE} where key='${STAGED_KEY}';`);
		sqlite(dbPath, "vacuum;");
		const absent = probe(dbPath, canary);
		say(`ABSENT case — record deleted`);
		say(`  ${JSON.stringify(absent)}`);
		if (absent.present) problems.push("absent: the record is still reported present after deletion");
		const absentVerdict = assertClean(dbPath, canary);
		if (absentVerdict.failures.length !== 0) {
			problems.push("absent: --assert-clean REFUSED an absent record");
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	if (problems.length > 0) {
		say("SELFTEST: FAIL");
		for (const p of problems) say(`  ${p}`);
		return 1;
	}
	say("SELFTEST: PASS (positive control detected and refused; tombstone and absent cases accepted)");
	return 0;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			out._.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (name === "selftest") {
			out.selftest = true;
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new ProbeError("missing-value", `--${name} requires a value`);
		}
		out[name] = next;
		i += 1;
	}
	return out;
}

function usage() {
	return [
		"usage:",
		"  rkstorage-staged-probe.mjs --db <path> --canary <token>",
		"  rkstorage-staged-probe.mjs --make-legacy <outfile> --canary <token> --expires <YYYY-MM-DDTHH:MM:SS>",
		"  rkstorage-staged-probe.mjs --assert-clean <path> --canary <token>",
		"  rkstorage-staged-probe.mjs --selftest",
	].join("\n");
}

function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`[staged-probe] ${err.name}: ${err.message}\n${usage()}\n`);
		return 2;
	}

	if (args.selftest) return selftest();

	const canary = args.canary;

	if (args["make-legacy"]) {
		if (!canary) {
			process.stderr.write("[staged-probe] canary-missing: --canary is required\n");
			return 2;
		}
		const synth = synthesizeLegacyRecord(canary, args.expires);
		const json = JSON.stringify(synth.record);
		writeFileSync(args["make-legacy"], json);
		process.stdout.write(
			`${JSON.stringify({
				wrote: args["make-legacy"],
				recordBytes: json.length,
				snapshotJsonBytes: synth.snapshotJsonBytes,
				keys: Object.keys(synth.record).sort(),
				fieldSetFromSource: synth.fields,
				fieldSetDrift: synth.drift,
				canary,
				expiresAt: synth.record.expiresAt,
			})}\n`,
		);
		if (synth.drift) {
			process.stderr.write(
				"[staged-probe] WARNING: the shipped persisted-record field set differs from the set " +
					"this probe was written against — the synthesized record follows the SOURCE, and " +
					"this probe's pinned expectation should be updated deliberately.\n",
			);
		}
		return 0;
	}

	if (args["assert-clean"]) {
		if (!canary) {
			process.stderr.write("[staged-probe] canary-missing: --canary is required\n");
			return 2;
		}
		const { observed, failures } = assertClean(args["assert-clean"], canary);
		process.stdout.write(`${JSON.stringify(observed)}\n`);
		if (failures.length > 0) {
			process.stderr.write("[staged-probe] ASSERT-CLEAN: FAIL\n");
			for (const f of failures) process.stderr.write(`[staged-probe]   ${f}\n`);
			return 1;
		}
		process.stdout.write("[staged-probe] ASSERT-CLEAN: PASS (all three conditions hold)\n");
		return 0;
	}

	if (args.db) {
		if (!canary) {
			process.stderr.write("[staged-probe] canary-missing: --canary is required\n");
			return 2;
		}
		process.stdout.write(`${JSON.stringify(probe(args.db, canary))}\n`);
		return 0;
	}

	process.stderr.write(`${usage()}\n`);
	return 2;
}

try {
	process.exit(main());
} catch (err) {
	if (err instanceof ProbeError) {
		process.stderr.write(`[staged-probe] ${err.name}: ${err.message}\n`);
		process.exit(1);
	}
	throw err;
}
