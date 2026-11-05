import { isValidRestBridgeUrl } from "@votetorrent/vote-engine/rn";
import type { AuthorityIntakePolicyView, AuthorityIntakePolicyInput } from "@votetorrent/vote-engine/rn";
import type { Signature } from "@votetorrent/vote-core";

/**
 * registration-bridge-config.ts — Phase 62 Plan 25 (D-29). Read/save of the Authority's
 * registration REST bridge URL, mirroring `officer-intake-key.ts`'s never-throw model pattern
 * field for field.
 *
 * D-29: the URL lives in the signed, replicated `AuthorityIntakePolicy` — every officer device
 * and the Voter (62-22) read the SAME value through `IntakeEngine.readIntakePolicy`. There is no
 * local, device-only configuration of any kind.
 *
 * A `'vrg'` threshold above 1 refuses with `IntakeError('threshold-requires-co-sign')` (62-14/
 * 62-13 GAP: this table has no co-sign Task path yet). This module reports that refusal as
 * `'co-sign-required'` — a TERMINAL outcome for the mount, never a retryable failure — so the UI
 * never offers a "Try again" that would just refuse identically again.
 *
 * The stored URL is world-readable (CLASS.PUBLIC, 62-01) — it is a sync endpoint, not a secret.
 *
 * This module never clears the saved URL: the 62-UI-SPEC defines no "clear bridge URL" action, so
 * an officer currently cannot turn the REST bridge back off from the app once a URL is saved. That
 * gap is recorded in this plan's SUMMARY as an open question, not solved here.
 *
 * No signer resolution happens in this file — the hosting screen resolves the device signer, so a
 * resolution failure routes through its own `useDeviceSigningErrorHandler`. No `console.`. Error
 * codes are read STRUCTURALLY (`name === 'IntakeError'` and a string `code`), never with
 * `instanceof` (Metro can duplicate a class across bundle chunks, breaking `instanceof` checks).
 */

export interface RegistrationBridgeConfig {
	readonly savedUrl: string | null;
	/** `undefined` only when the read itself failed. */
	readonly revision: number | undefined;
}

export type RegistrationBridgeSaveOutcome =
	| "saved"
	| "invalid-url"
	| "co-sign-required"
	| "not-authorized"
	| "conflict"
	| "failed";

export interface RegistrationBridgeConfigDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface BridgeConfigIntakeEngine {
	readIntakePolicy(authorityId: string): Promise<AuthorityIntakePolicyView>;
	setIntakePolicy(
		input: AuthorityIntakePolicyInput,
		sign: (digest: Uint8Array) => Promise<Signature>,
	): Promise<AuthorityIntakePolicyView>;
}

/** The single 62-14 https-only validator — trims first, since a copy/paste draft commonly carries
 * leading/trailing whitespace. */
export function isSaveableBridgeUrl(input: string): boolean {
	return isValidRestBridgeUrl(input.trim());
}

function toConfig(view: AuthorityIntakePolicyView): RegistrationBridgeConfig {
	return { savedUrl: view.restBridgeUrl, revision: view.revision };
}

/** Never throws: a rejected read (no engine, a network hiccup over the replicated store, etc.)
 * reports `{ savedUrl: null, revision: undefined }` rather than propagating. */
export async function readRegistrationBridgeConfig(
	deps: RegistrationBridgeConfigDeps,
	authorityId: string,
): Promise<RegistrationBridgeConfig> {
	try {
		const intake = await deps.getEngine<BridgeConfigIntakeEngine>("intake");
		const view = await intake.readIntakePolicy(authorityId);
		return toConfig(view);
	} catch {
		return { savedUrl: null, revision: undefined };
	}
}

function isIntakeError(err: unknown): err is { name: "IntakeError"; code: string } {
	if (typeof err !== "object" || err === null) return false;
	const e = err as { name?: unknown; code?: unknown };
	return e.name === "IntakeError" && typeof e.code === "string";
}

function mapOutcome(err: unknown): RegistrationBridgeSaveOutcome {
	if (isIntakeError(err)) {
		switch (err.code) {
			case "invalid-policy":
				// "invalid-url" now means ONLY the local pre-check (the card shows that itself); an
				// engine refusal of the policy must be visible as a save error.
				return "failed";
			case "threshold-requires-co-sign":
				return "co-sign-required";
			case "not-authorized":
			case "not-a-current-officer":
				return "not-authorized";
			case "policy-revision-conflict":
				return "conflict";
			default:
				return "failed";
		}
	}
	return "failed";
}

/**
 * Never throws: every failure resolves `{ outcome }` with `config` present ONLY for `'saved'`.
 * `reassociationMode` is never set by this module — it only ever writes `restBridgeUrl`.
 */
export async function saveRegistrationBridgeUrl(
	deps: RegistrationBridgeConfigDeps,
	authorityId: string,
	url: string,
	sign: (digest: Uint8Array) => Promise<Signature>,
	expectedRevision?: number,
): Promise<{ outcome: RegistrationBridgeSaveOutcome; config?: RegistrationBridgeConfig }> {
	const trimmed = url.trim();
	if (!isSaveableBridgeUrl(trimmed)) {
		return { outcome: "invalid-url" };
	}

	try {
		const intake = await deps.getEngine<BridgeConfigIntakeEngine>("intake");
		const view = await intake.setIntakePolicy(
			{
				authorityId,
				restBridgeUrl: trimmed,
				...(expectedRevision !== undefined ? { expectedRevision } : {}),
			},
			sign,
		);
		return { outcome: "saved", config: toConfig(view) };
	} catch (err) {
		return { outcome: mapOutcome(err) };
	}
}
