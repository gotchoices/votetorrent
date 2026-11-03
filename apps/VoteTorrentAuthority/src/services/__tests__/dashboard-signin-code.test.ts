/**
 * dashboard-signin-code.test.ts — Task 2 of 50-07, extended by Task 1 of
 * 50-15 (CR-03 gap closure: the payload must NEVER be persisted, not even
 * between mint and redemption — see the module header this suite exercises).
 *
 * DECLARED BLIND SPOT: this spec exercises no transport binding (neither the
 * filesystem binding nor a REST binding is constructed here) and no real wall
 * clock — every expiry/freshness decision is proven with INJECTED `now` values.
 * The real-clock rejection path (a code that expires purely from wall-clock
 * passage, with no test-supplied `now`) is listed in `50-VALIDATION.md` §
 * Manual-Only Verifications.
 *
 * Uses the real AsyncStorage jest mock mapped in `jest.config.js`
 * (`@react-native-async-storage/async-storage/jest/async-storage-mock.js`) and
 * clears it between cases, mirroring `device-user.provisioning.test.ts`'s
 * convention. `__resetInMemoryStateForTests()` additionally clears the
 * module's two in-memory-only slots (the staged payload and the registered
 * snapshot provider) — neither lives in AsyncStorage, so `AsyncStorage.clear()`
 * alone cannot reach them, and without this reset one test's mint could leak
 * its in-memory payload into a later "cold start" test.
 */

import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hexToBytes } from '@noble/curves/utils.js';
import {
	buildSnapshot,
	deriveBootstrapKeys,
	serializeSnapshot,
	unsealPayload,
} from '@votetorrent/vote-engine/bootstrap';
import type { BootstrapSnapshot } from '@votetorrent/vote-engine/bootstrap';
import {
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES,
	__resetInMemoryStateForTests,
	clearStagedSignInCode,
	mintDashboardSignInCode,
	purgeLegacyStagedPayload,
	readStagedSignInCode,
	redeemStagedSignInCode,
	registerDashboardSnapshotProvider,
	splitDashboardSignInCode,
	stageForFilesystemBinding,
} from '../dashboard-signin-code';
import type { BootstrapUploadRequest } from '../dashboard-signin-code';

const PII_CANARY = 'PII-CANARY-9f3a';

/** The ONE AsyncStorage key this module writes, spelled out literally the same
 * way the pre-existing cases already spell it — so a rename goes red here
 * rather than silently moving the payload to a key no canary scan watches. */
const STAGED_CODE_KEY = 'votetorrent.dashboardBootstrap.stagedCode';

/** The SECOND key this module writes — the pending-revoke marker a discard
 * leaves behind. Spelled literally for the same reason as the key above: a
 * rename must go red here rather than silently move the marker to a key no
 * canary scan watches. */
const PENDING_REVOKE_KEY = 'votetorrent.dashboardBootstrap.pendingRevoke';

/** A distinctive upstream failure message. It must NEVER reach the error this
 * module throws, nor the line it logs: the discipline is to carry the error
 * CLASS only, never the message. */
const UPSTREAM_MESSAGE_CANARY = 'UPSTREAM-DETAIL-CANARY-4b2e';

/**
 * An uploader that ACKS (resolves) and records what it was handed — plus, as
 * the D-03 ordering proof, what `AsyncStorage` held at the instant it was
 * called. Reading storage from INSIDE the uploader body is the whole point: it
 * observes the ordering directly rather than inferring it from a later state.
 */
function makeRecordingUploader(): {
	uploader: (request: BootstrapUploadRequest) => Promise<void>;
	requests: BootstrapUploadRequest[];
	storageAtUploadTime: Array<string | null>;
} {
	const requests: BootstrapUploadRequest[] = [];
	const storageAtUploadTime: Array<string | null> = [];
	async function uploader(request: BootstrapUploadRequest): Promise<void> {
		storageAtUploadTime.push(await AsyncStorage.getItem(STAGED_CODE_KEY));
		requests.push(request);
	}
	return { uploader, requests, storageAtUploadTime };
}

/** An uploader that REJECTS with an error carrying a distinctive `name` AND a
 * distinctive message, so the class-only logging discipline is observable
 * rather than assumed. */
function makeRejectingUploader(name: string): {
	uploader: (request: BootstrapUploadRequest) => Promise<void>;
	requests: BootstrapUploadRequest[];
} {
	const requests: BootstrapUploadRequest[] = [];
	async function uploader(request: BootstrapUploadRequest): Promise<void> {
		requests.push(request);
		const error = new Error(`refused: ${UPSTREAM_MESSAGE_CANARY}`);
		error.name = name;
		throw error;
	}
	return { uploader, requests };
}

function makeFixtureSnapshot(marker: string = PII_CANARY): BootstrapSnapshot {
	return buildSnapshot({
		networkHash: 'network-hash-fixture',
		tables: {
			Network: [{ Id: 'net-1', Marker: marker }],
		},
	});
}

beforeEach(async () => {
	await AsyncStorage.clear();
	__resetInMemoryStateForTests();
});

describe('mintDashboardSignInCode', () => {
	test('code is secret + "." + snapshot.digest, and the digest is recoverable via splitDashboardSignInCode', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });

		expect(minted.code).toBe(`${minted.secret}.${snapshot.digest}`);
		expect(minted.secret).toMatch(/^[0-9a-f]{40}$/);
		const split = splitDashboardSignInCode(minted.code);
		expect(split.digest).toBe(snapshot.digest);
		expect(split.secret).toBe(minted.secret);
	});

	test('expiresAt is exactly DASHBOARD_SIGNIN_CODE_SPAN_MINUTES minutes after the injected now, 19 chars, no Z', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now });

		expect(minted.expiresAt.length).toBe(19);
		expect(minted.expiresAt.endsWith('Z')).toBe(false);
		expect(minted.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		const expected = new Date(now.getTime() + DASHBOARD_SIGNIN_CODE_SPAN_MINUTES * 60_000)
			.toISOString()
			.slice(0, 19);
		expect(minted.expiresAt).toBe(expected);
	});

	test('two consecutive mints produce different secrets', async () => {
		const snapshot = makeFixtureSnapshot();
		const first = await mintDashboardSignInCode(snapshot);
		const second = await mintDashboardSignInCode(snapshot);
		expect(first.secret).not.toBe(second.secret);
	});

	test('supersedes: after a second mint, readStagedSignInCode returns only the second record, and the first secret redeems as unknown', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const first = await mintDashboardSignInCode(snapshot, { now });
		const second = await mintDashboardSignInCode(snapshot, { now });

		const staged = await readStagedSignInCode();
		expect(staged?.secret).toBe(second.secret);

		const firstResult = await redeemStagedSignInCode(first.secret, { now });
		expect(firstResult.status).toBe('unknown');
		expect(firstResult.snapshot).toBeUndefined();
	});

	test('no value in the minted record matches key-material markers', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot);
		const serialized = JSON.stringify(minted);
		expect(serialized).not.toMatch(/secp256k1|privateKey|randomSecretKey|getPublicKey/);
	});
});

describe('splitDashboardSignInCode', () => {
	test('rejects a code with no dot, more than one dot, a non-hex secret, or an empty digest — message contains neither half', () => {
		const secret = 'a'.repeat(40);
		const digest = 'b'.repeat(43);
		const cases = [secret, `${secret}.${digest}.extra`, `${'z'.repeat(40)}.${digest}`, `${secret}.`];
		for (const badCode of cases) {
			let thrown: Error | undefined;
			try {
				splitDashboardSignInCode(badCode);
			} catch (err) {
				thrown = err as Error;
			}
			expect(thrown).toBeDefined();
			expect(thrown!.message).not.toContain(secret);
			expect(thrown!.message).not.toContain(digest);
		}
	});
});

describe('redeemStagedSignInCode — expired / used / unknown, each with a positive control', () => {
	test('expired: redeeming past expiresAt returns "expired" with no snapshot; a fresh code in the same test returns "ok" with the snapshot (positive control)', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		const pastExpiry = new Date(mintNow.getTime() + (DASHBOARD_SIGNIN_CODE_SPAN_MINUTES + 1) * 60_000);
		const expiredResult = await redeemStagedSignInCode(minted.secret, { now: pastExpiry });
		expect(expiredResult.status).toBe('expired');
		expect(expiredResult.snapshot).toBeUndefined();

		// Positive control: a freshly minted code, redeemed before its expiry, succeeds.
		await clearStagedSignInCode();
		const freshMintNow = new Date('2026-02-01T00:00:00.000Z');
		const freshMinted = await mintDashboardSignInCode(snapshot, { now: freshMintNow });
		const withinExpiry = new Date(freshMintNow.getTime() + 60_000);
		const okResult = await redeemStagedSignInCode(freshMinted.secret, { now: withinExpiry });
		expect(okResult.status).toBe('ok');
		expect(okResult.snapshot).toEqual(snapshot);
	});

	test('used: a second redemption of the same secret returns "used" with no snapshot; the first call returned "ok" with the snapshot (positive control)', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const firstResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(firstResult.status).toBe('ok');
		expect(firstResult.snapshot).toEqual(snapshot);

		const secondResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(secondResult.status).toBe('used');
		expect(secondResult.snapshot).toBeUndefined();
	});

	test('unknown: an unrecognised secret returns "unknown", distinct from "expired" and "used"', async () => {
		const snapshot = makeFixtureSnapshot();
		await mintDashboardSignInCode(snapshot);

		const result = await redeemStagedSignInCode('f'.repeat(40));
		expect(result.status).toBe('unknown');
		expect(result.status).not.toBe('expired');
		expect(result.status).not.toBe('used');
		expect(result.snapshot).toBeUndefined();
	});

	test('concurrency: two redemptions fired without an intervening await resolve to exactly one "ok" and one "used"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const [r1, r2] = await Promise.all([
			redeemStagedSignInCode(minted.secret, { now: withinExpiry }),
			redeemStagedSignInCode(minted.secret, { now: withinExpiry }),
		]);

		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual(['ok', 'used']);
	});
});

/** Every value AsyncStorage currently holds, concatenated — so a canary scan
 * cannot be fooled by the payload moving to a different key. */
async function allStoredText(): Promise<string> {
	const keys = await AsyncStorage.getAllKeys();
	const entries = await Promise.all(keys.map((k) => AsyncStorage.getItem(k)));
	return entries.join('\n');
}

describe('the staged payload NEVER touches AsyncStorage — the CR-03 core', () => {
	test('mint: the RAW AsyncStorage string does not contain the PII canary or the "snapshotJson" substring, but DOES contain secret/digest/expiresAt/mintedAt', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		// Positive control first: the RETURNED (in-memory) record still carries
		// the payload, so `stageForFilesystemBinding` keeps working this session.
		// A canary that never fired here would prove nothing below.
		expect(minted.snapshotJson).toBeDefined();
		expect(minted.snapshotJson).toContain(PII_CANARY);

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		// The record still answers "does this code exist, and is it live?" honestly.
		expect(raw).toContain(minted.secret);
		expect(raw).toContain(minted.digest);
		expect(raw).toContain(minted.expiresAt);
		expect(raw).toContain(minted.mintedAt);
	});

	test('a successful redemption stamps redeemedAt and collapses the record to EXACTLY the tombstone key set, in the same write', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('ok');
		expect(result.snapshot).toEqual(snapshot);

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'lookupId', 'mintedAt', 'redeemedAt', 'secret'].sort(),
		);
		expect(parsed.redeemedAt).toBeDefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeDefined();
		expect(persisted?.snapshotJson).toBeUndefined();
	});

	test('an expiry refusal drops the record to the tombstone shape (no redeemedAt) but KEEPS it, so a second attempt still answers "expired"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const pastExpiry = new Date(mintNow.getTime() + (DASHBOARD_SIGNIN_CODE_SPAN_MINUTES + 1) * 60_000);

		expect((await redeemStagedSignInCode(minted.secret, { now: pastExpiry })).status).toBe('expired');

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'lookupId', 'mintedAt', 'secret'].sort(),
		);
		expect(parsed.redeemedAt).toBeUndefined();

		// Dropping the payload must not weaken the refusal to 'unknown' --
		// 'expired' tells the officer to generate a new code; 'unknown' does not.
		expect((await redeemStagedSignInCode(minted.secret, { now: pastExpiry })).status).toBe('expired');
	});

	test('a wrong-secret redemption attempt does not tombstone or clear the live record', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const wrongResult = await redeemStagedSignInCode('f'.repeat(40), { now: withinExpiry });
		expect(wrongResult.status).toBe('unknown');

		// The legitimate secret still redeems successfully afterwards — a wrong
		// guess must not have disturbed the live record.
		const okResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(okResult.status).toBe('ok');
		expect(okResult.snapshot).toEqual(snapshot);
	});
});

describe('registerDashboardSnapshotProvider — the regeneration fallback for a cold start', () => {
	test('no provider registered, and the in-memory payload is gone (simulated restart): redemption of an otherwise-live code returns "unknown" and does NOT stamp redeemedAt', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		// Simulate a process restart: the persisted record survives (it was
		// never in memory to begin with), the in-memory payload does not.
		__resetInMemoryStateForTests();

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
		expect(result.snapshot).toBeUndefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeUndefined();
	});

	test('a registered provider whose regenerated snapshot digest MATCHES the record: redemption returns "ok" with that snapshot', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		// A fresh snapshot built from IDENTICAL tables produces an IDENTICAL
		// digest (the digest covers `tables` only) — this is the regeneration
		// path's whole premise: the database has not changed since minting.
		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot());

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('ok');
		expect(result.snapshot?.digest).toBe(minted.digest);

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeDefined();
	});

	test('a registered provider whose regenerated snapshot digest DIFFERS from the record: redemption returns "unknown", does NOT stamp redeemedAt, and returns no snapshot', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		// A DIFFERENT marker means a DIFFERENT digest — the database changed
		// since minting. Never `'ok'` with bytes the code's out-of-band digest
		// does not pin.
		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot('a-different-marker-entirely'));

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
		expect(result.snapshot).toBeUndefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeUndefined();
	});

	test('registerDashboardSnapshotProvider(undefined) unregisters — a subsequent redemption with no in-memory payload returns "unknown"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot());
		registerDashboardSnapshotProvider(undefined);

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
	});
});

describe('stageForFilesystemBinding', () => {
	const FS_TRANSPORT_SOURCE = fs.readFileSync(
		path.join(
			__dirname,
			'../../../../../packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts',
		),
		'utf8',
	);

	test('emits exactly TWO documents — the dead snapshots/current.json plaintext copy is gone', async () => {
		// Source-level gate against the binding's OWN module: a rename on either
		// side goes red here, not silently.
		expect(FS_TRANSPORT_SOURCE).toContain('expiresAt');
		expect(FS_TRANSPORT_SOURCE).toContain('snapshotFile');
		expect(FS_TRANSPORT_SOURCE).toContain("join(this.rootDir, 'codes')");
		expect(FS_TRANSPORT_SOURCE).toContain("join(this.rootDir, 'snapshots')");
		// ...extended: the binding no longer mentions the shared document at
		// all, so a re-introduction on EITHER side goes red here.
		expect(FS_TRANSPORT_SOURCE).not.toContain('current.json');

		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });
		const docs = stageForFilesystemBinding(minted);

		const paths = docs.map((d) => d.path);
		expect(paths).toEqual([
			`codes/${minted.secret}.json`,
			`snapshots/${minted.snapshotName}.json`,
		]);
		// Asserted BY NAME, not merely by array length: this document was a
		// second full-plaintext copy of the authority's whole database on disk,
		// and its only reader was removed from the seam.
		expect(paths).not.toContain('snapshots/current.json');
	});

	test('the code record is unchanged: exactly expiresAt + snapshotFile, spelled the binding\'s way', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });
		const docs = stageForFilesystemBinding(minted);

		const codeDoc = JSON.parse(docs[0]!.contents);
		expect(Object.keys(codeDoc).sort()).toEqual(['expiresAt', 'snapshotFile']);
		expect(codeDoc.expiresAt).toBe(minted.expiresAt);
		expect(codeDoc.snapshotFile).toBe(minted.snapshotName);
	});

	test('the snapshot document is a SEALED WRAPPER that unseals to the envelope, and the hex round trip reproduces the mint own key split', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });
		const docs = stageForFilesystemBinding(minted);

		const wrapper = JSON.parse(docs[1]!.contents);
		expect(Object.keys(wrapper).sort()).toEqual(['ciphertext', 'nonce', 'v']);

		// THE GUARD that makes the hex round trip safe: keys derived from the
		// rendered hex must reproduce the split the mint derived from the RAW
		// bytes. Without this, a future encoding change would silently produce
		// a document the binding cannot open — the exact hazard the mint path
		// forbids the round trip in order to avoid.
		const keys = deriveBootstrapKeys(hexToBytes(minted.secret));
		expect(keys.lookupId).toBe(minted.lookupId);

		const result = unsealPayload(wrapper, keys);
		expect(result.ok).toBe(true);
		expect(result.ok ? result.plaintext : undefined).toBe(minted.snapshotJson);

		// Negative control: the staged document is ciphertext, not the envelope.
		expect(docs[1]!.contents).not.toContain(PII_CANARY);
	});

	test('calling it twice for the same record throws', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot);
		stageForFilesystemBinding(minted);
		expect(() => stageForFilesystemBinding(minted)).toThrow();
	});

	test('a re-read record (no in-memory payload) is still refused', async () => {
		const snapshot = makeFixtureSnapshot();
		await mintDashboardSignInCode(snapshot);
		const reRead = (await readStagedSignInCode())!;
		expect(reRead.snapshotJson).toBeUndefined();
		expect(() => stageForFilesystemBinding(reRead)).toThrow(/in-memory mint result/);
	});
});

describe('the REST-dead paths are marked, not left looking live', () => {
	const MARKER = 'FILESYSTEM-BINDING PATH ONLY.';

	test('the service module marks BOTH REST-dead entry points', () => {
		const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'dashboard-signin-code.ts'), 'utf8');
		const occurrences = serviceSource.split(MARKER).length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(2);
		// Positive control: this is the file it thinks it is.
		expect(serviceSource).toContain('export async function redeemStagedSignInCode');
		expect(serviceSource).toContain('export function registerDashboardSnapshotProvider');
	});

	test('the AppProvider registration site is marked too, so it does not read as live REST wiring', () => {
		const appProviderSource = fs.readFileSync(
			path.join(__dirname, '..', '..', 'providers', 'AppProvider.tsx'),
			'utf8',
		);
		expect(appProviderSource).toContain(MARKER);
		// Positive control.
		expect(appProviderSource).toContain('registerDashboardSnapshotProvider');
	});

	test("52-05's redemption-result type is CONSUMED, never redeclared: exactly one declaration in the file", () => {
		const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'dashboard-signin-code.ts'), 'utf8');
		const declarations = serviceSource.match(/type StagedSignInCodeRedemption/g) ?? [];
		expect(declarations).toHaveLength(1);
		// ...and the superseded seam type is gone from this file entirely.
		expect(serviceSource).not.toContain('BootstrapRedemptionResult');
	});
});

describe('PII / secret non-leakage', () => {
	test('no thrown message and no redemption result contains the PII canary or the bearer secret', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		let splitErrorMessage = '';
		try {
			splitDashboardSignInCode('not-a-valid-code');
		} catch (err) {
			splitErrorMessage = (err as Error).message;
		}
		expect(splitErrorMessage).not.toContain(PII_CANARY);
		expect(splitErrorMessage).not.toContain(minted.secret);

		const withinExpiry = new Date(mintNow.getTime() + 60_000);
		await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		const usedResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(JSON.stringify(usedResult)).not.toContain(minted.secret);
	});
});

describe('mintDashboardSignInCode — the D-03 seal-and-push path', () => {
	test('ORDERING: the uploader is handed the sealed wrapper BEFORE anything about the code reaches AsyncStorage', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests, storageAtUploadTime } = makeRecordingUploader();

		const minted = await mintDashboardSignInCode(snapshot, {
			now: new Date('2026-01-01T00:00:00.000Z'),
			uploader,
		});

		expect(requests).toHaveLength(1);
		// The uploader read storage from INSIDE its own body. On a first-ever
		// mint it must have observed nothing staged — that is the D-03 ordering
		// property asserted directly rather than inferred.
		expect(storageAtUploadTime).toEqual([null]);
		// Positive control: after the ack a record DOES exist, so the `null`
		// above is an ordering fact and not a storage mock that never works.
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).not.toBeNull();
		expect(minted.lookupId).toBe(requests[0]!.lookupId);
	});

	test('the seal wraps the REAL payload: it unseals, under keys derived from the minted secret, to exactly serializeSnapshot(snapshot)', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();
		const minted = await mintDashboardSignInCode(snapshot, { uploader });

		const request = requests[0]!;
		const keys = deriveBootstrapKeys(hexToBytes(minted.secret));
		const result = unsealPayload(request.sealed, keys);
		expect(result.ok).toBe(true);
		expect(result.ok ? result.plaintext : undefined).toBe(serializeSnapshot(snapshot));

		// Negative control: what actually crosses the wire is ciphertext, not
		// the payload in a costume.
		expect(JSON.stringify(request.sealed)).not.toContain(PII_CANARY);
	});

	test('request shape: exactly expiresAt/lookupId/sealed on a first mint, with revokeLookupId ABSENT rather than present-and-undefined', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const { uploader, requests } = makeRecordingUploader();
		const minted = await mintDashboardSignInCode(snapshot, { now, uploader });

		const request = requests[0]!;
		expect(Object.keys(request).sort()).toEqual(['expiresAt', 'lookupId', 'sealed']);
		expect('revokeLookupId' in request).toBe(false);

		expect(Object.keys(request.sealed).sort()).toEqual(['ciphertext', 'nonce', 'v']);
		expect(request.lookupId).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(request.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		expect(request.expiresAt.endsWith('Z')).toBe(false);
		expect(request.expiresAt).toBe(minted.expiresAt);
	});

	test('D-12: a second mint carries revokeLookupId equal to the FIRST mint lookupId, and the first mint carries no such key', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();

		const first = await mintDashboardSignInCode(snapshot, { uploader });
		const second = await mintDashboardSignInCode(snapshot, { uploader });

		expect(requests).toHaveLength(2);
		// Positive control on the FIRST request: absence, not undefined.
		expect('revokeLookupId' in requests[0]!).toBe(false);
		expect(requests[1]!.revokeLookupId).toBe(requests[0]!.lookupId);
		expect(requests[1]!.revokeLookupId).not.toBe(requests[1]!.lookupId);
		expect(requests[0]!.lookupId).toBe(first.lookupId);
		expect(requests[1]!.lookupId).toBe(second.lookupId);
	});

	test('D-12 across a MIXED history: a filesystem-path mint followed by a push mint still revokes the filesystem mint lookupId', async () => {
		const snapshot = makeFixtureSnapshot();
		// No uploader — the filesystem path. `lookupId` is persisted on the LIVE
		// record too, which is what makes the chain survive a mixed history.
		const filesystemMint = await mintDashboardSignInCode(snapshot);
		expect(filesystemMint.lookupId).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const { uploader, requests } = makeRecordingUploader();
		await mintDashboardSignInCode(snapshot, { uploader });

		expect(requests[0]!.revokeLookupId).toBe(filesystemMint.lookupId);
	});

	test('D-11: after the ack the stored record carries no payload, no snapshotName, and EXACTLY the tombstone key set plus lookupId', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader } = makeRecordingUploader();
		const minted = await mintDashboardSignInCode(snapshot, {
			now: new Date('2026-01-01T00:00:00.000Z'),
			uploader,
		});

		const raw = await AsyncStorage.getItem(STAGED_CODE_KEY);
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		// Whole-database scan, not a targeted key check: a payload that moved to
		// a different key would sail straight past the three assertions above.
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'lookupId', 'mintedAt', 'secret'].sort(),
		);
		// No `redeemedAt` — the code has not been redeemed; this record simply
		// never carried anything more than the tombstone shape.
		expect(parsed.redeemedAt).toBeUndefined();
		expect(parsed.lookupId).toBe(minted.lookupId);
	});

	test('D-11: the RETURNED push-path record carries no in-memory payload, so stageForFilesystemBinding refuses it — the no-uploader path is the paired positive control', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader } = makeRecordingUploader();

		const pushed = await mintDashboardSignInCode(snapshot, { uploader });
		expect(pushed.snapshotJson).toBeUndefined();
		expect(JSON.stringify(pushed)).not.toContain(PII_CANARY);
		expect(() => stageForFilesystemBinding(pushed)).toThrow(/in-memory mint result/);

		// Positive control: the filesystem path is untouched by the push path.
		const staged = await mintDashboardSignInCode(snapshot);
		expect(staged.snapshotJson).toBeDefined();
		expect(staged.snapshotJson).toContain(PII_CANARY);
		expect(() => stageForFilesystemBinding(staged)).not.toThrow();
	});

	test('a refused upload is ATOMIC: storage is byte-identical, the thrown error leaks nothing, and the prior code still redeems', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const recording = makeRecordingUploader();

		const codeA = await mintDashboardSignInCode(snapshot, { now, uploader: recording.uploader });
		const before = await AsyncStorage.getItem(STAGED_CODE_KEY);
		const allBefore = await allStoredText();

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const rejecting = makeRejectingUploader('UpstreamRefusedError');
		let thrown: Error | undefined;
		try {
			await mintDashboardSignInCode(snapshot, { now, uploader: rejecting.uploader });
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		expect(thrown!.name).toBe('BootstrapUploadFailedError');
		expect(thrown!.message).not.toContain(UPSTREAM_MESSAGE_CANARY);
		expect(thrown!.message).not.toContain(codeA.secret);
		expect(thrown!.message).not.toContain(codeA.lookupId);
		expect(thrown!.message).not.toContain(rejecting.requests[0]!.lookupId);
		expect(thrown!.message).not.toContain(rejecting.requests[0]!.sealed.ciphertext);
		// No `cause` chain either: a `cause` is the vector by which a raw
		// upstream message reaches a log line or a crash report.
		expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

		// The log line carries the error CLASS and nothing else.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warned = warnSpy.mock.calls[0]!.map(String).join(' ');
		expect(warned).toContain('UpstreamRefusedError');
		expect(warned).not.toContain(UPSTREAM_MESSAGE_CANARY);
		expect(warned).not.toContain(PII_CANARY);
		warnSpy.mockRestore();

		// Storage is byte-identical to what it was before the failed attempt.
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBe(before);
		expect(await allStoredText()).toBe(allBefore);

		// ...and code A is still redeemable. A push-path record is persisted in
		// the tombstone shape while its code is live, so this takes the
		// regeneration branch — which is why the provider is registered here,
		// exactly as the app shell registers it on mount.
		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot());
		const redeemed = await redeemStagedSignInCode(codeA.secret, {
			now: new Date(now.getTime() + 60_000),
		});
		expect(redeemed.status).toBe('ok');
		expect(redeemed.snapshot?.digest).toBe(codeA.digest);
	});

	test('a refused upload leaves the PREVIOUS filesystem-path mint in-memory payload intact, with no regeneration provider involved', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const codeA = await mintDashboardSignInCode(snapshot, { now });

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const rejecting = makeRejectingUploader('UpstreamRefusedError');
		await expect(
			mintDashboardSignInCode(snapshot, { now, uploader: rejecting.uploader }),
		).rejects.toThrow();
		warnSpy.mockRestore();

		// NO provider is registered, so an 'ok' here can only have come from the
		// untouched in-memory payload — the failure path assigned nothing to it.
		const redeemed = await redeemStagedSignInCode(codeA.secret, {
			now: new Date(now.getTime() + 60_000),
		});
		expect(redeemed.status).toBe('ok');
		expect(redeemed.snapshot).toEqual(snapshot);
	});

	test('a FIRST-EVER mint whose upload is refused leaves storage empty — an officer never holds a half-minted code', async () => {
		const snapshot = makeFixtureSnapshot();
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const rejecting = makeRejectingUploader('UpstreamRefusedError');

		await expect(
			mintDashboardSignInCode(snapshot, { uploader: rejecting.uploader }),
		).rejects.toThrow();
		warnSpy.mockRestore();

		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBeNull();
		const ourKeys = (await AsyncStorage.getAllKeys()).filter((k) =>
			k.startsWith('votetorrent.dashboardBootstrap'),
		);
		expect(ourKeys).toEqual([]);
		expect(await allStoredText()).not.toContain(PII_CANARY);
	});
});

describe('D-12 REACHABILITY — a discard must not sever the revoke chain', () => {
	/**
	 * THE POINT OF THIS BLOCK. The revoke was implemented and unit-tested while
	 * being unreachable from the product: the mint reads the prior `lookupId`
	 * off the staged record, `clearStagedSignInCode` destroys that record, and
	 * the producer screen renders no generate control while a code is live —
	 * so the officer MUST discard before re-minting, and the pre-existing
	 * "second mint" test only passed because it minted twice with no discard in
	 * between, a sequence the screen makes impossible. Every case below drives
	 * the real sequence through `clearStagedSignInCode` rather than seeding a
	 * marker by hand.
	 */
	test('THE OFFICER SEQUENCE — mint A, DISCARD, mint B: B carries revokeLookupId === A.lookupId (paired positive control: A carries no such key)', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();

		const codeA = await mintDashboardSignInCode(snapshot, {
			now: new Date('2026-01-01T00:00:00.000Z'),
			uploader,
		});
		// The discard is the step the screen forces and the step that used to
		// sever the chain. Nothing here reaches into storage directly.
		await clearStagedSignInCode();
		const codeB = await mintDashboardSignInCode(snapshot, {
			now: new Date('2026-01-01T00:02:00.000Z'),
			uploader,
		});

		expect(requests).toHaveLength(2);
		// Positive control, so the suite cannot pass vacuously: a FIRST-EVER
		// mint sends no revoke at all — the key ABSENT, not present-and-undefined.
		expect('revokeLookupId' in requests[0]!).toBe(false);
		expect(Object.keys(requests[0]!).sort()).toEqual(['expiresAt', 'lookupId', 'sealed']);

		// ...and the mint after the discard carries exactly A's lookupId.
		expect(requests[1]!.revokeLookupId).toBe(codeA.lookupId);
		expect(requests[1]!.lookupId).toBe(codeB.lookupId);
		expect(requests[1]!.revokeLookupId).not.toBe(requests[1]!.lookupId);
		expect(Object.keys(requests[1]!).sort()).toEqual([
			'expiresAt',
			'lookupId',
			'revokeLookupId',
			'sealed',
		]);
	});

	test('the marker a discard leaves holds EXACTLY { expiresAt, lookupId } — no code, secret, digest, snapshotName or payload, under a whole-store canary', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader } = makeRecordingUploader();
		const codeA = await mintDashboardSignInCode(snapshot, {
			now: new Date('2026-01-01T00:00:00.000Z'),
			uploader,
		});

		await clearStagedSignInCode();

		const raw = await AsyncStorage.getItem(PENDING_REVOKE_KEY);
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		// KEY-SET EQUALITY, not a spot check: a future field added to this
		// marker has to come here and argue for itself.
		expect(Object.keys(parsed).sort()).toEqual(['expiresAt', 'lookupId']);
		expect(parsed.lookupId).toBe(codeA.lookupId);
		expect(parsed.expiresAt).toBe(codeA.expiresAt);
		expect(typeof parsed.expiresAt).toBe('string');
		expect((parsed.expiresAt as string).length).toBe(19);
		expect((parsed.expiresAt as string).endsWith('Z')).toBe(false);

		// The credential the discard exists to destroy is GONE from the marker,
		// by value and not merely by key name.
		expect(raw).not.toContain(codeA.secret);
		expect(raw).not.toContain(codeA.digest);
		expect(raw).not.toContain(codeA.code);
		expect(raw).not.toContain(codeA.snapshotName);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain(PII_CANARY);

		// The staged record itself is really gone — the marker is an addition to
		// the discard, never a softening of it.
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBeNull();

		// WHOLE-STORE canary: the secret and the payload are absent from EVERY
		// key, so a credential that merely moved keys cannot sail past the
		// targeted assertions above.
		const everything = await allStoredText();
		expect(everything).not.toContain(codeA.secret);
		expect(everything).not.toContain(codeA.digest);
		expect(everything).not.toContain(PII_CANARY);
		expect(everything).not.toContain('snapshotJson');
		// ...and the only keys this module now owns are the two named ones.
		const ourKeys = (await AsyncStorage.getAllKeys())
			.filter((k) => k.startsWith('votetorrent.dashboardBootstrap'))
			.sort();
		expect(ourKeys).toEqual([PENDING_REVOKE_KEY]);
	});

	test('a discard of a PRE-lookupId record writes NO marker (paired positive control: a current record does)', async () => {
		// A record shaped exactly as a build before `lookupId` was persisted
		// wrote it. There is nothing the service could revoke, so an empty
		// marker — indistinguishable from a real pending revoke — must not
		// appear.
		await AsyncStorage.setItem(
			STAGED_CODE_KEY,
			JSON.stringify({
				code: `${'a'.repeat(40)}.${'b'.repeat(43)}`,
				secret: 'a'.repeat(40),
				digest: 'b'.repeat(43),
				expiresAt: '2026-01-01T00:10:00',
				mintedAt: '2026-01-01T00:00:00',
			}),
		);
		await clearStagedSignInCode();
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).toBeNull();

		// ...and a mint that follows it sends no revoke either.
		const { uploader, requests } = makeRecordingUploader();
		await mintDashboardSignInCode(makeFixtureSnapshot(), { uploader });
		expect('revokeLookupId' in requests[0]!).toBe(false);

		// Positive control: the same discard on a CURRENT record does write one,
		// so the `toBeNull()` above is a fact about the legacy shape and not a
		// marker path that never works.
		await clearStagedSignInCode();
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).not.toBeNull();
	});

	test('the marker is dropped once its revoke has been DELIVERED, and a later failed mint does not resurrect it', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();

		const codeA = await mintDashboardSignInCode(snapshot, { uploader });
		await clearStagedSignInCode();
		const codeB = await mintDashboardSignInCode(snapshot, { uploader });
		expect(requests[1]!.revokeLookupId).toBe(codeA.lookupId);

		// Delivered, therefore dropped — A must not be revoked a second time on
		// every subsequent upload for the rest of the device's life.
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).toBeNull();

		// A refused mint must not put it back.
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const rejecting = makeRejectingUploader('UpstreamRefusedError');
		await expect(mintDashboardSignInCode(snapshot, { uploader: rejecting.uploader })).rejects.toThrow();
		warnSpy.mockRestore();
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).toBeNull();

		// The chain still advances: discard B, mint C, and C revokes B — not the
		// long-since-delivered A.
		await clearStagedSignInCode();
		await mintDashboardSignInCode(snapshot, { uploader });
		expect(requests[2]!.revokeLookupId).toBe(codeB.lookupId);
		expect(requests[2]!.revokeLookupId).not.toBe(codeA.lookupId);
	});

	test('a REFUSED mint after a discard leaves the marker intact, so the next mint still carries the revoke', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();
		const codeA = await mintDashboardSignInCode(snapshot, { uploader });
		await clearStagedSignInCode();
		const markerBefore = await AsyncStorage.getItem(PENDING_REVOKE_KEY);

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const rejecting = makeRejectingUploader('UpstreamRefusedError');
		await expect(mintDashboardSignInCode(snapshot, { uploader: rejecting.uploader })).rejects.toThrow();
		warnSpy.mockRestore();

		// The refused attempt DID carry the revoke — proof the marker fed it —
		// and the marker is byte-identical afterwards because the revoke was
		// never acknowledged.
		expect(rejecting.requests[0]!.revokeLookupId).toBe(codeA.lookupId);
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).toBe(markerBefore);
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBeNull();

		// ...so the retry still revokes A. A refused upload must not silently
		// consume the one chance to retire a code the service is still holding.
		await mintDashboardSignInCode(snapshot, { uploader });
		expect(requests[1]!.revokeLookupId).toBe(codeA.lookupId);
		expect(await AsyncStorage.getItem(PENDING_REVOKE_KEY)).toBeNull();
	});

	test('an EXPIRED marker still produces a revoke — the phone never decides on the service behalf that a code has lapsed', async () => {
		const snapshot = makeFixtureSnapshot();
		const { uploader, requests } = makeRecordingUploader();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const codeA = await mintDashboardSignInCode(snapshot, { now: mintNow, uploader });
		await clearStagedSignInCode();

		// Well past A's own expiry. The expiry DECISION belongs to the service,
		// whose clock is not this phone's, so suppressing the revoke here could
		// leave live at the service a code this phone has already forgotten.
		const longAfter = new Date(mintNow.getTime() + (DASHBOARD_SIGNIN_CODE_SPAN_MINUTES + 120) * 60_000);
		await mintDashboardSignInCode(snapshot, { now: longAfter, uploader });

		expect(requests[1]!.revokeLookupId).toBe(codeA.lookupId);
	});

	test('a live staged record still wins over a marker, and an undelivered marker is not dropped by a mint that did not use it', async () => {
		const snapshot = makeFixtureSnapshot();
		// Reachable only through the filesystem path (no uploader), which is the
		// one way a staged record and a marker can coexist: a discard removes
		// the record, and a push mint clears the marker on its ack.
		const codeA = await mintDashboardSignInCode(snapshot);
		await clearStagedSignInCode();
		const codeB = await mintDashboardSignInCode(snapshot); // no uploader: nothing delivered

		const { uploader, requests } = makeRecordingUploader();
		await mintDashboardSignInCode(snapshot, { uploader });

		// The LIVE record wins — it is the newer of the two facts.
		expect(requests[0]!.revokeLookupId).toBe(codeB.lookupId);
		// ...and A's marker, whose revoke was never delivered, survives rather
		// than being dropped by an upload that did not carry it.
		const marker = JSON.parse((await AsyncStorage.getItem(PENDING_REVOKE_KEY))!) as Record<string, unknown>;
		expect(marker.lookupId).toBe(codeA.lookupId);
	});
});

describe('D-13 — the ten-minute span is unchanged', () => {
	test('DASHBOARD_SIGNIN_CODE_SPAN_MINUTES is 10, and a default-options mint expires exactly 600000 ms after it was minted', async () => {
		expect(DASHBOARD_SIGNIN_CODE_SPAN_MINUTES).toBe(10);

		const minted = await mintDashboardSignInCode(makeFixtureSnapshot());
		expect(Date.parse(`${minted.expiresAt}Z`) - Date.parse(`${minted.mintedAt}Z`)).toBe(600_000);
	});
});

describe('purgeLegacyStagedPayload — the D-28 startup sweep', () => {
	/** A record in the PRE-FIX shape. It is seeded with `setItem` directly
	 * because no fixture and no code path in the current tree can produce one:
	 * `PersistedStagedRecord`'s `Omit` made this shape unwritable, which is
	 * precisely why the devices already carrying one are stranded. */
	async function seedLegacyRecord(extra: Record<string, unknown> = {}): Promise<string> {
		const legacy = {
			code: `${'a'.repeat(40)}.${'b'.repeat(43)}`,
			secret: 'a'.repeat(40),
			digest: 'b'.repeat(43),
			expiresAt: '2026-01-01T00:10:00',
			mintedAt: '2026-01-01T00:00:00',
			snapshotName: 'snapshot-aaaaaaaaaaaaaaaa',
			snapshotJson: JSON.stringify({
				formatVersion: 1,
				tables: { Registrant: [{ Id: 'r-1', Name: PII_CANARY }] },
				padding: 'x'.repeat(4096),
			}),
			...extra,
		};
		const raw = JSON.stringify(legacy);
		await AsyncStorage.setItem(STAGED_CODE_KEY, raw);
		return raw;
	}

	test('the core case: a seeded pre-fix record is collapsed to a tombstone, proven by reading storage BACK', async () => {
		const seeded = await seedLegacyRecord();
		// Positive control: the canary really is in storage before the sweep.
		expect(seeded).toContain(PII_CANARY);
		expect(await allStoredText()).toContain(PII_CANARY);

		const outcome = await purgeLegacyStagedPayload();

		// STORAGE FIRST, deliberately. D-11 is a property of what remains on the
		// device, not of what the function returned; asserting the returned enum
		// before the read-back would let a sweep that classified correctly and
		// then wrote nothing sail through, and would make this case's mutation
		// proof fail on the token rather than on the payload.
		const raw = await AsyncStorage.getItem(STAGED_CODE_KEY);
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		// No `lookupId` — a pre-fix record never had one, so the tombstone must
		// have the key ABSENT rather than present-and-undefined.
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'mintedAt', 'secret'].sort(),
		);

		expect(outcome).toBe('legacy-payload');
	});

	test('the record SURVIVES as a tombstone rather than being deleted, so the device can still answer precisely', async () => {
		await seedLegacyRecord();
		expect(await purgeLegacyStagedPayload()).toBe('legacy-payload');

		const parsed = JSON.parse((await AsyncStorage.getItem(STAGED_CODE_KEY))!) as Record<string, unknown>;
		expect(parsed.code).toBe(`${'a'.repeat(40)}.${'b'.repeat(43)}`);
		expect(parsed.secret).toBe('a'.repeat(40));
		expect(parsed.digest).toBe('b'.repeat(43));
		expect(parsed.expiresAt).toBe('2026-01-01T00:10:00');
	});

	test('a REDEEMED legacy record keeps its redeemedAt', async () => {
		await seedLegacyRecord({ redeemedAt: '2026-01-01T00:05:00' });
		expect(await purgeLegacyStagedPayload()).toBe('legacy-payload');

		const raw = await AsyncStorage.getItem(STAGED_CODE_KEY);
		expect(raw).not.toContain(PII_CANARY);
		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'mintedAt', 'redeemedAt', 'secret'].sort(),
		);
		expect(parsed.redeemedAt).toBe('2026-01-01T00:05:00');
	});

	test('the clean case is a BYTE-IDENTICAL no-op on a record a current build wrote — the paired positive control', async () => {
		await mintDashboardSignInCode(makeFixtureSnapshot(), { now: new Date('2026-01-01T00:00:00.000Z') });
		const before = await AsyncStorage.getItem(STAGED_CODE_KEY);

		expect(await purgeLegacyStagedPayload()).toBe('clean');
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBe(before);
	});

	test('idempotence: sweeping a swept record returns "clean" and changes nothing further', async () => {
		await seedLegacyRecord();
		expect(await purgeLegacyStagedPayload()).toBe('legacy-payload');
		const afterFirst = await AsyncStorage.getItem(STAGED_CODE_KEY);

		expect(await purgeLegacyStagedPayload()).toBe('clean');
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBe(afterFirst);
	});

	test('absent: empty storage returns "absent" and writes nothing', async () => {
		expect(await purgeLegacyStagedPayload()).toBe('absent');
		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBeNull();
	});

	test('unreadable: an unparseable value that still contains the canary is REMOVED outright', async () => {
		await AsyncStorage.setItem(STAGED_CODE_KEY, `{not json at all ${PII_CANARY}`);
		expect(await allStoredText()).toContain(PII_CANARY);

		expect(await purgeLegacyStagedPayload()).toBe('unreadable');

		expect(await AsyncStorage.getItem(STAGED_CODE_KEY)).toBeNull();
		expect(await allStoredText()).not.toContain(PII_CANARY);
	});

	test('it NEVER throws — a crash here would take app start with it', async () => {
		// Absent.
		await expect(purgeLegacyStagedPayload()).resolves.toBeDefined();
		// Unparseable.
		await AsyncStorage.setItem(STAGED_CODE_KEY, 'not json');
		await expect(purgeLegacyStagedPayload()).resolves.toBe('unreadable');
		// A legacy record missing `expiresAt` entirely.
		await AsyncStorage.setItem(
			STAGED_CODE_KEY,
			JSON.stringify({ code: 'x.y', secret: 'x', digest: 'y', snapshotJson: PII_CANARY }),
		);
		await expect(purgeLegacyStagedPayload()).resolves.toBe('legacy-payload');
		expect(await allStoredText()).not.toContain(PII_CANARY);
		// A JSON scalar, not an object.
		await AsyncStorage.setItem(STAGED_CODE_KEY, '42');
		await expect(purgeLegacyStagedPayload()).resolves.toBeDefined();
		// A JSON null.
		await AsyncStorage.setItem(STAGED_CODE_KEY, 'null');
		await expect(purgeLegacyStagedPayload()).resolves.toBeDefined();
	});

	test('the app shell CALLS the sweep on mount — not merely defines it', () => {
		const appProviderSource = fs.readFileSync(
			path.join(__dirname, '..', '..', 'providers', 'AppProvider.tsx'),
			'utf8',
		);
		// Imported from this very module...
		expect(appProviderSource).toMatch(
			/import\s*\{[^}]*purgeLegacyStagedPayload[^}]*\}\s*from\s*"\.\.\/services\/dashboard-signin-code"/,
		);
		// ...and referenced inside a useEffect, not just imported. The slice
		// between `useEffect(` and the sweep reference is what proves the call
		// site is inside an effect body rather than dead top-level prose.
		const effectIndex = appProviderSource.indexOf('purgeLegacyStagedPayload()');
		expect(effectIndex).toBeGreaterThan(-1);
		const precedingEffect = appProviderSource.lastIndexOf('useEffect(', effectIndex);
		expect(precedingEffect).toBeGreaterThan(-1);
		// No `return` between the effect's opening and the sweep call — this
		// project has shipped a gate that logged "needed" and then sat behind an
		// unconditional early return, which made it inert.
		const effectPrelude = appProviderSource.slice(precedingEffect, effectIndex);
		expect(effectPrelude).not.toMatch(/\breturn\b/);

		// Positive control: this is the file it thinks it is.
		expect(appProviderSource).toContain('registerDashboardSnapshotProvider');
	});
});
