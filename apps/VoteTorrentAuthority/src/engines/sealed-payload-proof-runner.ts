/**
 * sealed-payload-proof-runner.ts — Phase 52 dev-only boot runner (D-05)
 *
 * Fire-and-forget from index.js after AppRegistry.registerComponent.
 * No-op when SEALED_PAYLOAD_PROOF_ENABLED is false or __DEV__ is false.
 * Never throws — any failure is logged as [seal-kat] FATAL so the app still boots.
 *
 * Driven by scripts/run-sealed-payload-proof.sh, which flips the flag, greps the
 * SERVED bundle for provenance, waits for the verdict line, and then decrypts
 * the wrapper this proof emitted with node:crypto on the host.
 * Everything is logged to logcat under the [seal-kat] tag.
 */

import { runSealedPayloadProof } from './sealed-payload-proof';
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
import { SEALED_PAYLOAD_PROOF_ENABLED } from './proof-flags.generated';

/**
 * Boot entry point. Fire-and-forget from index.js after the app registers.
 * Never throws — any failure is logged as [seal-kat] FATAL so the app still boots.
 * No-op unless BOTH `__DEV__` and `SEALED_PAYLOAD_PROOF_ENABLED` are true — the
 * single gate below is the only place that conjunction is spelled, so a grep for
 * it finds the guard and nothing else.
 */
export async function runSealedPayloadProofRunner(): Promise<void> {
	if (!(__DEV__ && SEALED_PAYLOAD_PROOF_ENABLED)) {
		return;
	}
	try {
		await runSealedPayloadProof();
	} catch (err) {
		// Class name only — a raw message could interpolate key or payload bytes.
		const cls =
			(err as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
		console.error(`[seal-kat] FATAL — ${cls}`);
		console.info('[seal-kat] ========== SEALED PAYLOAD VERDICT: FAIL ==========');
	}
}
