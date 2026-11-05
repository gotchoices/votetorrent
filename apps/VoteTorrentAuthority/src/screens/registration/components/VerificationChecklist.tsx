import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import {
	isChecklistGateMet,
	canonicalizeVerificationChecklist,
	VERIFICATION_CHECKLIST_ITEM_ORDER,
	VERIFICATION_CHECKLIST_NONE_ITEM,
} from "@votetorrent/vote-core";
import type { RegistrationVerificationChecklistItem } from "@votetorrent/vote-core";

/**
 * VerificationChecklist — the D-07 structured out-of-band verification
 * record. Composed above 48-19's approval/reject footer, interactive on the
 * pending-decision path and read-only on a decided request's detail view.
 *
 * **The gate is 48-06's, not this component's.** `isChecklistGateMet` (from
 * `@votetorrent/vote-core`) is called EXACTLY ONCE, inside `handleToggle`,
 * and its boolean result is the only gate value this file ever produces —
 * emitted upward as `onChange`'s second argument. No local `canApprove`, no
 * `checked.length > 0`, no `checked.includes("none") && ...` expression may
 * ever be added here: a locally-rewritten predicate that happens to agree
 * with 48-06's today is exactly the drift this separation exists to
 * prevent. 48-06's `verification-checklist.spec.ts` already proves the rule
 * (assertions 13-17); this file only calls it and reports its result.
 *
 * **The item vocabulary is not re-declared.** `RegistrationVerificationChecklistItem`
 * is 48-05's union, imported type-only. Rows are produced by mapping over
 * the imported `VERIFICATION_CHECKLIST_ITEM_ORDER` — there is no second,
 * locally-declared four-element array of checklist ids, and the visual
 * top-to-bottom row order is deliberately identical to 48-06's canonical
 * serialization order (`id`, `roll`, `eligibility`, `none` last).
 *
 * **This component owns no button.** The Approve/Reject footer, the digest
 * fetch, the signing call, and navigation all belong to 48-19. This
 * component reports `checked`/`gateMet` upward via `onChange` and stops.
 *
 * **Honest labelling.** The checklist gate is a UI legibility control, not a
 * security boundary — nothing in the schema enforces it. Tamper-EVIDENCE
 * for the record comes from 48-06's canonical digest and 48-11's binding of
 * that digest into the `AdminSigning.Digest` the officer actually signs, not
 * from this component. This file makes no claim that the `'vrg'` scope gate
 * is enforced — `AdminSigning.SignerKeyValid` / `OfficerSignature.OfficerValid`
 * are hardcoded stub CHECKs (Phase 999.1), a pre-existing, out-of-scope gap.
 *
 * **Never-log rule (carried from Phase 47's `PrivateFieldRow`).** This file
 * writes nothing to `console.*`, declares no error state, performs no
 * serialization, and binds no checklist value into a translated string
 * other than the four fixed label-key lookups.
 */

/**
 * The one new mapping this plan owns: checklist id -> 48-03's i18n key.
 * Typing the record's key as the union means a fifth vocabulary item would
 * be a compile error here, not a silently unlabelled row.
 */
export const VERIFICATION_CHECKLIST_LABEL_KEYS: Record<RegistrationVerificationChecklistItem, string> = {
	id: "verificationChecklistItemId",
	roll: "verificationChecklistItemRoll",
	eligibility: "verificationChecklistItemEligibility",
	none: "verificationChecklistItemNone",
};

export interface VerificationChecklistProps {
	/**
	 * Controlled state. The component holds NO local checklist state: in
	 * read-only mode these props ARE the decision-time record, and a local
	 * copy would let what is rendered diverge from what was signed.
	 */
	checked: readonly RegistrationVerificationChecklistItem[];
	/**
	 * Fired on every toggle in interactive mode. `next` is already canonical
	 * (passed through `canonicalizeVerificationChecklist`); `gateMet` is
	 * `isChecklistGateMet(next)` — the AUTHORITATIVE gate value. 48-19 must
	 * consume this value rather than deriving its own. A pending request
	 * always mounts with `checked = []`, so the screen's initial disabled
	 * state is `false` without needing to call anything.
	 */
	onChange: (next: RegistrationVerificationChecklistItem[], gateMet: boolean) => void;
	/** Default `false`. */
	readOnly?: boolean;
	/** An ISO-Z timestamp, rendered only when `readOnly` is true and present. */
	decidedAt?: string;
	testIDPrefix?: string;
}

/**
 * Formats an ISO-Z timestamp to `YYYY-MM-DD`, returning the input unchanged
 * on anything unparseable rather than throwing — `registrant-display.ts`'s
 * `formatExpirationDate` never-throw discipline. A decided request's detail
 * screen must never crash on a malformed stored timestamp.
 */
function formatDecidedAt(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().split("T")[0]!;
}

export function VerificationChecklist({
	checked,
	onChange,
	readOnly = false,
	decidedAt,
	testIDPrefix = "verification-checklist",
}: VerificationChecklistProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	/**
	 * The toggle handler — where mutual exclusion is actually enforced.
	 * Derives `next` OUTSIDE any state updater as a plain local (there is no
	 * component state here; this mirrors `PrivateFieldRow`'s discipline of
	 * keeping side-effect-producing derivations pure and outside React's
	 * update machinery).
	 *
	 * "I verified nothing" and "I verified ID" cannot both be true, so the
	 * exclusion is structural rather than a copy hint:
	 *   1. If `item` is currently checked, the next set is the current set
	 *      minus `item` — an unchecking action never adds anything.
	 *   2. Otherwise, if `item` is the `none` sentinel, the next set is
	 *      exactly `['none']` — every substantive item is dropped.
	 *   3. Otherwise (`item` is substantive), the next set is the current
	 *      set plus `item`, with `none` removed.
	 *
	 * 48-06's `isChecklistGateMet` independently rejects the `none`+substantive
	 * combination too — the duplication is deliberate defence in depth: this
	 * handler prevents the incoherent state from being CONSTRUCTED; the
	 * predicate prevents an incoherent state that arrived some other way from
	 * SATISFYING the gate.
	 */
	function handleToggle(item: RegistrationVerificationChecklistItem) {
		if (readOnly) return;

		const isChecked = checked.some((c) => c === item);
		let nextRaw: RegistrationVerificationChecklistItem[];
		if (isChecked) {
			nextRaw = checked.filter((c) => c !== item);
		} else if (item === VERIFICATION_CHECKLIST_NONE_ITEM) {
			nextRaw = [VERIFICATION_CHECKLIST_NONE_ITEM];
		} else {
			nextRaw = [...checked.filter((c) => c !== VERIFICATION_CHECKLIST_NONE_ITEM), item];
		}

		// Canonicalizing on emit is what makes the bytes the screen later
		// hashes identical to the bytes 48-06's spec pinned, regardless of
		// the order the officer happened to tap in.
		const canonical = canonicalizeVerificationChecklist(nextRaw);
		onChange(canonical, isChecklistGateMet(canonical));
	}

	return (
		<View testID={testIDPrefix} style={[styles.cardSurface, { backgroundColor: colors.card }]}>
			<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-title`}>
				{t("verificationChecklistSectionTitle")}
			</ThemedText>

			{VERIFICATION_CHECKLIST_ITEM_ORDER.map((item) => {
				const isChecked = checked.some((c) => c === item);
				const labelKey = VERIFICATION_CHECKLIST_LABEL_KEYS[item];
				const glyphName = isChecked ? "square-check" : "square";
				const glyphColor = isChecked ? colors.success : colors.textSecondary;

				const inner = (
					<>
						<View testID={`${testIDPrefix}-glyph-${item}`} style={localStyles.glyphBox}>
							<FontAwesome6 name={glyphName} size={20} color={glyphColor} />
						</View>
						<ThemedText
							type="defaultSemiBold"
							testID={`${testIDPrefix}-label-${item}`}
							style={localStyles.itemLabel}
						>
							{t(labelKey)}
						</ThemedText>
					</>
				);

				return (
					<View key={item} testID={`${testIDPrefix}-row-${item}`} style={localStyles.propertyRow}>
						{readOnly ? (
							<View style={localStyles.tapTarget}>{inner}</View>
						) : (
							<TouchableOpacity
								testID={`${testIDPrefix}-toggle-${item}`}
								onPress={() => handleToggle(item)}
								accessibilityRole="checkbox"
								accessibilityState={{ checked: isChecked }}
								accessibilityLabel={t(labelKey)}
								hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
								style={localStyles.tapTarget}
							>
								{inner}
							</TouchableOpacity>
						)}
					</View>
				);
			})}

			{/*
			 * Informational, not a second gate: no acknowledgement checkbox, no
			 * "I understand" step, nothing anywhere in this file is conditioned
			 * on the officer having seen or acted on this notice.
			 */}
			<ThemedText type="small" style={{ color: colors.textSecondary }} testID={`${testIDPrefix}-binding-notice`}>
				{t("verificationChecklistBindingNotice")}
			</ThemedText>

			{readOnly && decidedAt ? (
				<ThemedText type="small" style={{ color: colors.textSecondary }} testID={`${testIDPrefix}-decided-at`}>
					{t("verificationChecklistDecidedAtLabel") + ": " + formatDecidedAt(decidedAt)}
				</ThemedText>
			) : null}
		</View>
	);
}

const localStyles = StyleSheet.create({
	propertyRow: {
		flexDirection: "row",
		alignItems: "center",
		width: "100%",
	},
	tapTarget: {
		minHeight: 44,
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
		gap: 8,
	},
	glyphBox: {
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	// D-07 (48-27, closing 48-UAT.md gap 4): `flex: 1` is sufficient here and
	// was NOT sufficient in 48-26's CustomButton case — this row is genuinely
	// width-constrained (`propertyRow` is `width: "100%"`, `tapTarget` is
	// `flex: 1`), so the label receives the row width minus `glyphBox`'s 44
	// and the 8 gap, and RN wraps the text within it. CustomButton's
	// `buttonContent` row is content-sized under an `alignItems: "center"`
	// parent, which is why its `flexShrink: 1` never engaged there. Do not
	// conclude the two cases are the same bug and "unify" them. No
	// line-count truncation prop, no `ellipsizeMode` — an officer attesting
	// to a checklist item they could not fully read is exactly the defect
	// this closes.
	itemLabel: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
