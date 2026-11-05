/**
 * deviceSigningRollout.coverage.test.ts — the D-09/D-13/D-14 completeness gate (49-12).
 *
 * 49-11 built the shared `useDeviceSigningErrorHandler` hook and routed 8 call-site files.
 * 49-12 routed the remaining 9. This test is what keeps that rollout complete GOING FORWARD:
 * it derives its inventory of `createDeviceSigner` call sites from the source tree itself
 * (never a hardcoded list), so a future call site added without routing fails THIS suite
 * instead of silently reopening the dead-end gap 49-UI-SPEC.md's degradation clause warns
 * about (an officer whose key is invalidated lands on a raw, unroutable error string with no
 * path back to recovery).
 *
 * Reconciliation this test encodes (so a future reader does not conclude the rollout is short):
 *   - 27 non-test files under `src` reference `device-signer` in some form.
 *   - 25 of those actually INVOKE `createDeviceSigner(` (a call expression, not a comment) —
 *     62-11's lazy ballot-submit signer, now `screens/ballots/EditBallotScreen.tsx` (moved there from CreateBallotScreen by 62-55: the persisted ballot is where submit lives; inventory unchanged at 25), 62-23's
 *     `screens/networks/components/FoundingBundleExportCard.tsx` (the founding-bundle export
 *     signer), and 62-25's `screens/registration/BulkImportSyncScreen.tsx` (the registration
 *     bridge-URL save action) are all among them.
 *   - 23 of the 25 route through `useDeviceSigningErrorHandler` (8 from 49-11, 9 from 49-12,
 *     1 from `screens/dashboard/PairBrowserScreen.tsx` (the browser-pairing request signer; it
 *     replaced the dashboard sign-in code screen, so the counts are unchanged), 1 from
 *     62-11's ballot-submit signer (now `screens/ballots/EditBallotScreen.tsx` after the 62-55 move; routed count unchanged at 23), 1 from 62-23's
 *     `screens/networks/components/FoundingBundleExportCard.tsx`, and 1 from 62-25's
 *     `screens/registration/BulkImportSyncScreen.tsx`), and 2 from 62-27
 *     (`screens/registration/AssociationRequestApprovalScreen.tsx`, the device-change review
 *     ceremony, and `screens/elections/components/ReassociationReviewToggle.tsx`, the D-46
 *     re-association review setting; both route through the hook).
 *   - 2 of the 25 are named, justified exemptions (`ROLLOUT_EXEMPT` below) — unchanged by 62-25.
 *   - 62-25 (D-28/D-29) REMOVES two of the four prior registration-sync exemptions:
 *     `screens/registration/attach-sync-bindings.ts` no longer invokes `createDeviceSigner(` at
 *     all (the bridge-key auto-provisioning loop that called it is deleted — T-62-25-02), and
 *     `screens/registration/attach-association-sync-bindings.ts` is deleted outright (D-28: no
 *     association REST/filesystem app binding exists any more). Neither 62-21's
 *     `attach-peer-sync-binding.ts` nor `officer-intake-key.ts` invoke `createDeviceSigner(`
 *     directly — both take an injected `createSigner` dependency instead (see each file's own
 *     header). 62-25 ADDS exactly one new invoker, `BulkImportSyncScreen.tsx` (routed through the
 *     hook, so ROLLOUT_EXEMPT is unaffected): net effect, the inventory count goes 24 -> 22 (Task
 *     1, the two registration-sync removals) -> 23 (Task 3, the one screen addition) -> 25 (62-27: the
 *     device-change review screen and the re-association review toggle, both routed through the hook).
 *   - 2 files (`engines/registrant-dev-seed.ts`, `engines/signing-proof.ts`) reference
 *     `createDeviceSigner` only in prose comments, never as a call — they are correctly
 *     excluded from the invocation inventory by this test's comment-stripping walk, and are NOT
 *     part of the 25/23/21/2/2 arithmetic above (27 = 25 invokers + 2 comment-only).
 *   - 2026-11-02 ADDS exactly one invoker, `screens/elections/ElectionResultsScreen.tsx` (an officer
 *     publishes the signed ElectionTally row), routed through the hook, so ROLLOUT_EXEMPT is unchanged:
 *     invokers 25 -> 26, routed 23 -> 24, files referencing `device-signer` 27 -> 28.
 *   - The paired-browsers list ADDS exactly one invoker, `screens/dashboard/PairedBrowsersScreen.tsx`
 *     (the paired-browser Remove signer, routed through the hook), so ROLLOUT_EXEMPT is unchanged:
	 *     invokers 26 -> 27, routed 24 -> 25.
 *   - The administration-change Cancel ADDS exactly one invoker,
 *     `screens/authorities/useAdminChangeCancel.ts` (the one-prompt Cancel change signer shared by
 *     Authority Details and Proposed Administration), routed through the hook, so ROLLOUT_EXEMPT is
 *     unchanged: invokers 27 -> 28.
 *
 * Convention mirrors this workspace's other release-guard-style source-inspection tests (see
 * `engines/__tests__/`): reads files as TEXT rather than importing them, so it fails on what is
 * ACTUALLY on disk (and therefore what `git add` would stage / what Metro would bundle), not on
 * some transformed in-memory representation. (Deliberately not naming a sibling guard test's own
 * filename in prose here — one of those siblings greps the whole `src` tree for its own subject
 * string and a literal filename mention above would trip on itself.)
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

/**
 * The files that invoke `createDeviceSigner(` but must NEVER route through
 * `useDeviceSigningErrorHandler`. Each entry carries a one-line rationale. Adding an entry here
 * is a deliberate, reviewable act — not a silent omission — because test 4 below re-derives the
 * invocation set from the tree and asserts every non-exempt member routes.
 *
 * 62-25 (D-28/D-29) removes the two prior registration-sync exemptions:
 * `screens/registration/attach-sync-bindings.ts` no longer invokes `createDeviceSigner(` at all
 * (its bridge-key auto-provisioning loop — the only call site — is deleted, T-62-25-02), and
 * `screens/registration/attach-association-sync-bindings.ts` is deleted outright (D-28).
 */
const ROLLOUT_EXEMPT: string[] = [
	// Its call constructs the LAZY factory thunk; it never resolves a signer and
	// never signs. D-14 is explicit that no signer is resolved and this screen is
	// never auto-navigated-to during provider construction or cold start —
	// AppProvider.tsx's own comment records that doing so can turn a successful
	// re-attach into a spurious "Failed to load network". Navigating from here is
	// precisely the forbidden behavior.
	'providers/AppProvider.tsx',
	// Device-proof harness with no UI surface and no navigation context. Same
	// class of exemption as D-11's dev-seed carve-out.
	'engines/persistence-proof.ts',
];

/** Recursively lists every `.ts`/`.tsx` file under `dir`, excluding `__tests__` segments. */
function listSourceFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === '__tests__') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(full));
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Strips `//` line comments and `/* ... *\/` block comments from source text so a
 * prose mention of `createDeviceSigner(` inside documentation (e.g.
 * `registrant-dev-seed.ts`'s "`createDeviceSigner` reads the device's raw...") is
 * never mistaken for a real call expression. Deliberately simple (no string-literal
 * awareness) — sufficient for this codebase's actual comment shapes, matching the
 * precision level a sibling release-guard source-shape test elsewhere in this
 * directory already uses for a comparable assertion.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n');
}

describe('D-09/D-13/D-14 rollout completeness: every createDeviceSigner call site routes through useDeviceSigningErrorHandler', () => {
	const allFiles = listSourceFiles(SRC_ROOT);

	// The hook itself and the taxonomy it wraps reference `createDeviceSigner` only
	// in doc comments (if at all) — exclude the hook file explicitly per the plan's
	// walk spec so it never accidentally satisfies its own invariant.
	const DEVICE_SIGNER_IMPL = path.join(SRC_ROOT, 'engines', 'device-signer.ts');

	const invokingFiles = allFiles
		.filter((f) => f !== DEVICE_SIGNER_IMPL)
		.filter((f) => {
			const stripped = stripComments(fs.readFileSync(f, 'utf8'));
			return /createDeviceSigner\(/.test(stripped);
		})
		.map((f) => path.relative(SRC_ROOT, f))
		.sort();

	it('the call-site inventory has exactly 28 members (fail loud, with the full list, if this drifts)', () => {
		if (invokingFiles.length !== 28) {
			throw new Error(
				`Expected exactly 28 createDeviceSigner(...) call-site files, found ` +
					`${invokingFiles.length}:\n${invokingFiles.join('\n')}`,
			);
		}
		expect(invokingFiles).toHaveLength(28);
	});

	it('ROLLOUT_EXEMPT has exactly 2 entries', () => {
		expect(ROLLOUT_EXEMPT).toHaveLength(2);
	});

	it('every entry in ROLLOUT_EXEMPT is actually present in the collected invocation set (no stale exemptions)', () => {
		for (const exempt of ROLLOUT_EXEMPT) {
			expect(invokingFiles).toContain(exempt);
		}
	});

	it('every non-exempt invoking file references useDeviceSigningErrorHandler', () => {
		const exemptSet = new Set(ROLLOUT_EXEMPT);
		const offenders: string[] = [];
		for (const rel of invokingFiles) {
			if (exemptSet.has(rel)) continue;
			const source = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
			if (!/useDeviceSigningErrorHandler/.test(source)) {
				offenders.push(rel);
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`The following createDeviceSigner call site(s) do NOT route through ` +
					`useDeviceSigningErrorHandler: ${offenders.join(', ')}. An unrouted site ` +
					`leaves an officer with no path forward on key invalidation — either route ` +
					`it through the shared hook or add it to ROLLOUT_EXEMPT with a written reason.`,
			);
		}
		expect(offenders).toEqual([]);
	});

	it('the ProvisionSigningKey navigation target is referenced from exactly the hook and the Settings entry point (no per-screen duplicate)', () => {
		const pattern = /navigate\(["']ProvisionSigningKey["']/;
		const offenders: string[] = [];
		const matches: string[] = [];
		for (const f of allFiles) {
			const rel = path.relative(SRC_ROOT, f);
			const source = fs.readFileSync(f, 'utf8');
			if (pattern.test(source)) {
				matches.push(rel);
			}
		}
		const allowed = new Set([
			path.join('hooks', 'useDeviceSigningErrorHandler.ts'),
			// 49-19: the recovery-key-registration gate. Added as a HOOK, deliberately, so the
			// create/join trigger honours this contract instead of scattering the navigation
			// target across AddNetworkScreen and NetworkDetailsScreen (which is exactly the
			// per-screen duplication this test exists to prevent).
			path.join('hooks', 'useRecoveryKeyRegistrationGate.ts'),
			path.join('screens', 'settings', 'SettingsScreen.tsx'),
		]);
		for (const rel of matches) {
			if (!allowed.has(rel)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
		// Also assert the allowed set is fully accounted for — a missing entry here
		// would mean the navigation contract silently regressed to zero sites.
		expect(matches.sort()).toEqual([...allowed].sort());
	});
});
