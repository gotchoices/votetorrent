import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type {
	ElectionRegistrationField,
	ElectionDisclosurePolicy,
	DisclosureAudience,
} from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { globalStyles } from "../../../theme/styles";

/**
 * DisclosurePolicySection — the ElectionDisclosurePolicy audience editor for the
 * Registration Policy screen (D-03), with immediate per-row apply (D-14) and a
 * canWrite affordance gate (D-10).
 *
 * Purely presentational: receives data + callbacks as props. No engine calls,
 * no signing, no schema access, no N+1 ballot-per-election detail read — the
 * owning screen (46-08) is responsible for reads, writes, device-side
 * signing, and computing hasDistrictedBallot from the ballot summaries plus
 * their per-ballot detail reads.
 */

/**
 * Leg B of the D-03 compound gate: is a `District` field entry declared in
 * this election's ElectionRegistrationField list? Case-insensitive, mirroring
 * the engine's publicFixedByLowerName convention.
 */
export function hasDistrictFieldDeclared(fields: ElectionRegistrationField[]): boolean {
	return fields.some(f => f.fieldName.toLowerCase() === "district");
}

/**
 * D-03 — STRICT compound AND of two independent legs:
 *   Leg A: hasDistrictedBallot, supplied by the screen (46-08) from the
 *          ballot-summary list plus a per-ballot detail read (the N+1 pattern
 *          UI-SPEC Pattern 4 describes — the summary list itself carries no
 *          districts field).
 *   Leg B: a District entry exists in this election's ElectionRegistrationField
 *          list (hasDistrictFieldDeclared).
 *
 * Collapsing this to Leg A alone would let 'district' be chosen before a
 * District field exists, producing exactly the D-04 orphan-disclosure state
 * (T-46-04) — a disclosure rule whose audience can never resolve.
 */
export function isDistrictAudienceAvailable(
	fields: ElectionRegistrationField[],
	hasDistrictedBallot: boolean,
): boolean {
	return hasDistrictedBallot && hasDistrictFieldDeclared(fields);
}

/**
 * Case-folded disclosure lookup (folded-in WR-01, T-46-12-02). An
 * ElectionDisclosurePolicy row has no FK to ElectionRegistrationField (D-04),
 * so a row can genuinely be stored under a differently-cased fieldName. Every
 * sibling module in this domain folds case — registration-policy-reconciliation.ts,
 * hasDistrictFieldDeclared above, RegistrationFieldsSection.isDuplicate, and
 * the screen's own onSetAudience — so an exact-match lookup here would render
 * "Not set" for a field that IS disclosed, understating the disclosure
 * surface and defeating the already-selected no-op guard in handleSetAudience.
 */
function findDisclosureForField(
	disclosures: ElectionDisclosurePolicy[],
	fieldName: string,
): ElectionDisclosurePolicy | undefined {
	return disclosures.find(d => d.fieldName.toLowerCase() === fieldName.toLowerCase());
}

type RowStatus = "idle" | "saving" | "saved" | "error";

export interface DisclosurePolicySectionProps {
	fields: ElectionRegistrationField[];
	disclosures: ElectionDisclosurePolicy[];
	hasDistrictedBallot: boolean;
	canWrite: boolean;
	onSetAudience: (fieldName: string, audience: DisclosureAudience) => Promise<void>;
	onRemoveDisclosure: (fieldName: string) => Promise<void>;
}

export function DisclosurePolicySection({
	fields,
	disclosures,
	hasDistrictedBallot,
	canWrite,
	onSetAudience,
	onRemoveDisclosure,
}: DisclosurePolicySectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	// D-14 per-row write state. Keyed by fieldName so an audience change and a
	// remove on the same field share one status map.
	const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
	const [retryHandlers, setRetryHandlers] = useState<Record<string, () => void>>({});

	async function runWrite(fieldName: string, op: () => Promise<void>) {
		setRowStatus(prev => ({ ...prev, [fieldName]: "saving" }));
		try {
			await op();
			setRowStatus(prev => ({ ...prev, [fieldName]: "saved" }));
		} catch {
			setRowStatus(prev => ({ ...prev, [fieldName]: "error" }));
			setRetryHandlers(prev => ({ ...prev, [fieldName]: () => runWrite(fieldName, op) }));
		}
	}

	function handleSetAudience(field: ElectionRegistrationField, audience: DisclosureAudience) {
		const current = findDisclosureForField(disclosures, field.fieldName)?.audience;
		if (current === audience) return;
		runWrite(field.fieldName, () => onSetAudience(field.fieldName, audience));
	}

	function handleRemove(field: ElectionRegistrationField) {
		runWrite(field.fieldName, () => onRemoveDisclosure(field.fieldName));
	}

	function handleRetry(fieldName: string) {
		const retry = retryHandlers[fieldName];
		if (retry) retry();
	}

	/**
	 * D-10 canWrite gate. ChipButton has no `disabled` prop, so every write
	 * control is wrapped in a pointerEvents-gated View and its onPress is
	 * conditionally undefined. This is a UI affordance for legibility, NOT a
	 * security boundary — the DB-side 'mel' AdminSignature CHECK
	 * (MutationValid/DeleteValid on ElectionDisclosurePolicy) is the real
	 * control (T-46-03, D-10). Controls stay visible/rendered when disabled;
	 * only interaction is blocked.
	 */
	function writeWrap(testID: string, onPress: (() => void) | undefined, child: React.ReactNode) {
		return (
			<View
				key={testID}
				testID={testID}
				pointerEvents={canWrite ? "auto" : "none"}
				style={canWrite ? undefined : styles.disabledControl}
			>
				{React.isValidElement(child)
					? React.cloneElement(child as React.ReactElement<{ onPress?: () => void }>, {
							onPress: canWrite ? onPress : undefined,
						})
					: child}
			</View>
		);
	}

	const selectiveFields = fields.filter(f => f.tier === "selective");
	const districtAvailable = isDistrictAudienceAvailable(fields, hasDistrictedBallot);

	return (
		<View testID="disclosure-policy-section" style={styles.section}>
			<ThemedText type="title">{t("registrationPolicyDisclosureSectionTitle")}</ThemedText>

			{!districtAvailable && (
				<View testID="disclosure-district-unavailable-hint">
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationPolicyAudienceDistrictUnavailableHint")}
					</ThemedText>
				</View>
			)}

			{selectiveFields.length === 0 ? (
				<View testID="disclosure-empty">
					<ThemedText type="defaultSemiBold">{t("registrationPolicyNoDisclosureHeading")}</ThemedText>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationPolicyNoDisclosureBody")}
					</ThemedText>
				</View>
			) : (
				selectiveFields.map(field => {
					const status: RowStatus = rowStatus[field.fieldName] ?? "idle";
					const currentAudience = findDisclosureForField(disclosures, field.fieldName)?.audience;
					const hasDisclosure = currentAudience !== undefined;

					return (
						<View testID={`disclosure-row-${field.fieldName}`} key={field.fieldName} style={localStyles.row}>
							<ThemedText type="defaultSemiBold">{field.fieldName}</ThemedText>
							{status === "saved" && (
								<FontAwesome6 name="check" size={14} color={colors.success} />
							)}

							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("registrationPolicyAudienceLabel")}
							</ThemedText>

							{/*
							 * Current-audience legibility (D-03/D-10, closes 46-VERIFICATION.md
							 * gap-2 / 46-REVIEW.md CR-02). Deliberately OUTSIDE the
							 * status==="saving" ternary below and BEFORE the
							 * disclosure-status- View: it must stay rendered while a write
							 * is in flight AND while canWrite is false, since that
							 * persistence is the entire point of the D-10 read-only
							 * legibility half of this fix. currentAudience always comes
							 * straight from props via the case-folded lookup above (never
							 * mirrored into local state), so this also satisfies D-14
							 * prior-value integrity — a rejected write leaves the ORIGINAL
							 * audience on screen, never the attempted one.
							 */}
							<View testID={`disclosure-current-audience-${field.fieldName}`}>
								<ThemedText type="defaultSemiBold">
									{currentAudience === "district"
										? t("registrationPolicyAudienceDistrict")
										: currentAudience === "everyone"
											? t("registrationPolicyAudienceEveryone")
											: t("registrationPolicyAudienceNotSet")}
								</ThemedText>
							</View>

							<View testID={`disclosure-status-${field.fieldName}`}>
								{status === "saving" ? (
									<ThemedText type="small" style={{ color: colors.textSecondary }}>
										{t("registrationPolicyRowSaving")}
									</ThemedText>
								) : (
									<>
										<View style={localStyles.chipRow}>
											{writeWrap(
												`disclosure-audience-${field.fieldName}-everyone`,
												() => handleSetAudience(field, "everyone"),
												<ChipButton
													label={t("registrationPolicyAudienceEveryone")}
													icon={currentAudience === "everyone" ? "check" : undefined}
												/>,
											)}
											{districtAvailable &&
												writeWrap(
													`disclosure-audience-${field.fieldName}-district`,
													() => handleSetAudience(field, "district"),
													<ChipButton
														label={t("registrationPolicyAudienceDistrict")}
														icon={currentAudience === "district" ? "check" : undefined}
													/>,
												)}
										</View>

										{hasDisclosure &&
											writeWrap(
												`disclosure-remove-${field.fieldName}`,
												() => handleRemove(field),
												<ChipButton label={t("registrationPolicyRemoveButton")} />,
											)}
									</>
								)}

								{status === "error" && (
									<>
										<ThemedText type="small" style={{ color: colors.error }}>
											{t("registrationPolicyRowError")}
										</ThemedText>
										<View testID={`disclosure-retry-${field.fieldName}`}>
											<ChipButton
												label={t("registrationPolicyRetryButton")}
												onPress={() => handleRetry(field.fieldName)}
											/>
										</View>
									</>
								)}
							</View>
						</View>
					);
				})
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		gap: 4,
		marginTop: 8,
	},
	chipRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
	disabledControl: {
		opacity: 0.5,
	},
});

const styles = { ...globalStyles, ...localStyles };
