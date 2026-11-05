import React, { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { ElectionAttestationPolicy } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { globalStyles } from "../../../theme/styles";

/**
 * AttestationPolicySection — the tri-state ElectionAttestationPolicy editor for
 * the Registration Policy screen (D-07), with immediate per-action apply
 * (D-14) and a canWrite affordance gate (D-10).
 *
 * Purely presentational: receives data + callbacks as props. No engine calls,
 * no signing, no schema access — the owning screen (46-08) is responsible for
 * reads, writes and device-side signing.
 */

export type AttestationState = "not-configured" | "required" | "not-required";

/**
 * T-46-02 mitigation — the whole reason this component exists as a separate
 * pure function. `getElectionAttestationPolicy` returns `undefined` when no
 * row exists, and the fail-closed "absent = REQUIRED" rule lives in the
 * associate ceremony, not the read — so the UI must apply that default
 * itself, HERE. The `policy === undefined` branch MUST be checked first,
 * before any `attestationRequired` property access. Do NOT "simplify" this by
 * coalescing an absent policy directly to a false-y default, by double-negating
 * `policy?.attestationRequired`, or by wrapping it in a bare truthiness cast —
 * every one of those silently maps "no row" to "not required", telling the
 * officer attestation is OFF when the associate ceremony will in fact REQUIRE
 * it. (See T-46-02 in the phase threat model for the exact prohibited forms.)
 */
export function resolveAttestationState(
	policy: ElectionAttestationPolicy | undefined,
): AttestationState {
	if (policy === undefined) return "not-configured";
	if (policy.attestationRequired === true) return "required";
	return "not-required";
}

type RowStatus = "idle" | "saving" | "saved" | "error";

// A stable no-op for the (non-optional) CustomButton.onPress prop when
// canWrite is false — belt-and-suspenders alongside `disabled` so no
// callback can fire even from a direct programmatic invocation.
const NOOP = () => {};

export interface AttestationPolicySectionProps {
	policy: ElectionAttestationPolicy | undefined;
	canWrite: boolean;
	onSetAttestation: (attestationRequired: boolean) => Promise<void>;
	onRevertToDefault: () => Promise<void>;
}

export function AttestationPolicySection({
	policy,
	canWrite,
	onSetAttestation,
	onRevertToDefault,
}: AttestationPolicySectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	// D-14 write state. This section has exactly one logical row (a single
	// attestation policy per election), so a single status + retry handler is
	// enough — no per-row keying like the sibling sections need.
	const [status, setStatus] = useState<RowStatus>("idle");
	const [retryHandler, setRetryHandler] = useState<(() => Promise<void>) | undefined>(undefined);

	async function runWrite(op: () => Promise<void>) {
		setStatus("saving");
		try {
			await op();
			setStatus("saved");
		} catch {
			setStatus("error");
			setRetryHandler(() => op);
		}
	}

	function handleSetAttestation(attestationRequired: boolean) {
		runWrite(() => onSetAttestation(attestationRequired));
	}

	function handleRevert() {
		runWrite(() => onRevertToDefault());
	}

	function handleRetry() {
		if (retryHandler) runWrite(retryHandler);
	}

	// D-14 prior-state integrity: `state` is recomputed from `props.policy` on
	// every render — there is no `useState(policy)` and no optimistic local
	// copy, so a rejected write simply leaves the previously displayed state
	// on screen with no rollback logic needed.
	const state = resolveAttestationState(policy);

	let glyphName: string;
	let glyphColor: string;
	let labelColor: string;
	let labelKey: string;
	let bodyKey: string;

	if (state === "not-configured") {
		glyphName = "circle-info";
		glyphColor = colors.textSecondary;
		labelColor = colors.textSecondary;
		labelKey = "registrationPolicyAttestationNotConfiguredLabel";
		bodyKey = "registrationPolicyAttestationNotConfiguredBody";
	} else if (state === "required") {
		glyphName = "shield-halved";
		glyphColor = colors.success;
		labelColor = colors.text;
		labelKey = "registrationPolicyAttestationRequiredLabel";
		bodyKey = "registrationPolicyAttestationRequiredBody";
	} else {
		glyphName = "shield-halved";
		glyphColor = colors.warning;
		labelColor = colors.text;
		labelKey = "registrationPolicyAttestationNotRequiredLabel";
		bodyKey = "registrationPolicyAttestationNotRequiredBody";
	}

	/**
	 * D-10 canWrite gate. `disabled={!canWrite}` on every action control below
	 * is a UI affordance for legibility, NOT a security boundary — the
	 * DB-side 'mel' AdminSignature CHECK (MutationValid/DeleteValid on
	 * ElectionAttestationPolicy) is the real control (T-46-03, D-10).
	 * Controls stay visible/rendered when disabled; only interaction is
	 * blocked, so a read-only officer still sees the full policy. `onPress` is
	 * ALSO set to `undefined` when `!canWrite` (belt-and-suspenders alongside
	 * `disabled`) so no callback can fire even from a direct programmatic
	 * invocation of the handler, not just from a blocked touch event.
	 */
	function renderRequireButton() {
		return (
			<View testID="attestation-action-require">
				<CustomButton
					size="thin"
					title={t("registrationPolicyAttestationRequireButton")}
					backgroundColor={colors.accent}
					disabled={!canWrite}
					onPress={canWrite ? () => handleSetAttestation(true) : NOOP}
				/>
			</View>
		);
	}

	function renderDontRequireButton() {
		return (
			<View testID="attestation-action-dont-require">
				<CustomButton
					size="thin"
					title={t("registrationPolicyAttestationDontRequireButton")}
					backgroundColor={colors.accent}
					disabled={!canWrite}
					onPress={canWrite ? () => handleSetAttestation(false) : NOOP}
				/>
			</View>
		);
	}

	// Revert is TERTIARY — a plain-text TouchableOpacity, not a CustomButton
	// pill, so it never competes visually with the primary toggle. There is
	// nothing to revert from in the not-configured state, so this is never
	// rendered there (see the JSX below).
	function renderRevertButton() {
		return (
			<TouchableOpacity
				testID="attestation-action-revert"
				disabled={!canWrite}
				style={localStyles.revertButton}
				onPress={canWrite ? handleRevert : undefined}
			>
				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t("registrationPolicyAttestationRevertButton")}
				</ThemedText>
			</TouchableOpacity>
		);
	}

	return (
		<View testID="attestation-policy-section" style={styles.section}>
			<ThemedText type="title">{t("registrationPolicyAttestationSectionTitle")}</ThemedText>

			<View testID={`attestation-state-${state}`} style={localStyles.stateBlock}>
				<View style={localStyles.labelRow}>
					<FontAwesome6 name={glyphName} size={16} color={glyphColor} />
					<ThemedText type="defaultSemiBold" testID="attestation-state-label" style={{ color: labelColor }}>
						{t(labelKey)}
					</ThemedText>
					{status === "saved" && <FontAwesome6 name="check" size={14} color={colors.success} />}
				</View>

				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t(bodyKey)}
				</ThemedText>

				<View testID="attestation-status">
					{status === "saving" ? (
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationPolicyRowSaving")}
						</ThemedText>
					) : (
						<View style={localStyles.actionRow}>
							{state === "not-configured" && (
								<>
									{renderRequireButton()}
									{renderDontRequireButton()}
								</>
							)}
							{state === "required" && (
								<>
									{renderDontRequireButton()}
									{renderRevertButton()}
								</>
							)}
							{state === "not-required" && (
								<>
									{renderRequireButton()}
									{renderRevertButton()}
								</>
							)}
						</View>
					)}

					{status === "error" && (
						<>
							<ThemedText type="small" style={{ color: colors.error }}>
								{t("registrationPolicyRowError")}
							</ThemedText>
							<View testID="attestation-retry">
								<CustomButton
									size="thin"
									title={t("registrationPolicyRetryButton")}
									onPress={handleRetry}
								/>
							</View>
						</>
					)}
				</View>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	stateBlock: {
		gap: 4,
		marginTop: 8,
	},
	labelRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	actionRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 8,
	},
	revertButton: {
		paddingVertical: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
