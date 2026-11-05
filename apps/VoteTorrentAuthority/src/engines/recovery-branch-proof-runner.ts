/**
 * recovery-branch-proof-runner.ts — dev-only boot runner for D-26a's LOCAL half.
 *
 * Fire-and-forget from index.js. No-op unless __DEV__ && RECOVERY_BRANCH_PROOF_ENABLED.
 * Never throws — a failure is logged so the app still boots.
 *
 * Everything is logged under [d26a-local]. Driven by scripts/run-recovery-branch-proof.sh,
 * which also gates on the OS-level CONFIRM_DEVICE_CREDENTIAL activity so the branch is
 * MEASURED rather than inferred from the SDK level.
 */

import { Platform } from 'react-native';
import { runRecoveryBranchProof } from './recovery-branch-proof';
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
import { RECOVERY_BRANCH_PROOF_ENABLED } from './proof-flags.generated';
import { RECOVERY_KEY_ALIAS } from './device-signer';
import NativeAttestation from '@votetorrent/attestation-native/src/specs/NativeAttestation';

export async function runRecoveryBranchProofRunner(): Promise<void> {
	if (!(__DEV__ && RECOVERY_BRANCH_PROOF_ENABLED)) {
		return;
	}
	try {
		const sdkInt = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
		await runRecoveryBranchProof(
			NativeAttestation as unknown as Parameters<typeof runRecoveryBranchProof>[0],
			RECOVERY_KEY_ALIAS,
			sdkInt,
			{
				// Deliberately explicit that the DEVICE CREDENTIAL is wanted — a human reading the
				// prompt must not reach for the fingerprint sensor, which is the thing that
				// invalidated the signing key.
				title: 'Recovery signing proof',
				subtitle: 'Confirm with your device PIN, pattern or password',
				negative: 'Cancel',
			},
			Platform.OS,
		);
	} catch (err) {
		console.error('[d26a-local] FATAL —', err);
		console.info('[d26a-local] ========== D-26A LOCAL VERDICT: FAIL ==========');
	}
}
