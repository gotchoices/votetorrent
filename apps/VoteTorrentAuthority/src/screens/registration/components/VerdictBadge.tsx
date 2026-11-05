import React, { useState } from "react";
import { TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../../components/ThemedText";
import { tintPill, pillStyles } from "./pill";

/**
 * VerdictBadge — the shared D-03 pass/fail/no-verdict pill with tap-to-expand
 * fail reason.
 *
 * Purely presentational: `verdict` is a structural `"pass" | "fail" |
 * undefined` union, NOT a vote-core-package type import — 47-08 (which
 * introduces the `AttestationVerdict` model) runs in the same wave as this
 * plan, so a type import from it would not resolve. Neither this file nor
 * `LifecycleConfirmCard.tsx` may import the vote-core package, the
 * vote-engine package, the engines layer, or navigation beyond
 * `useTheme`/`ExtendedTheme`.
 *
 * T-47-03 negative space: a verdict is a RECORD of what the verifier
 * concluded, not a control. This component renders no `CustomButton`, no
 * `ChipButton`, and nothing labelled re-verify / retry / clear / override —
 * there is no re-verification driver anywhere in this system (an explicit
 * Deferred Idea), so any such affordance would be a dead control implying a
 * capability that does not exist.
 */

export type VerdictBadgeVerdict = "pass" | "fail" | undefined;
export type VerdictState = "pass" | "fail" | "none";

/**
 * Resolves the three-state discriminant off an explicit `undefined`-first
 * check (the `AttestationPolicySection.resolveAttestationState` discipline):
 * an absent verdict is its OWN state, never coalesced into "fail". Per Phase
 * 45 D-14a..D-14e, a present `AttestationCid` is NOT evidence of a verdict —
 * the non-attested association path writes one too — so `"none"` is a real,
 * common, non-error state, not an edge case. Checking `verdict === undefined`
 * FIRST (rather than e.g. `verdict ?? "fail"` or a truthiness cast) is
 * load-bearing: either of those silently maps "no verdict recorded" to a
 * false accusation of Fail.
 */
export function resolveVerdictState(verdict: VerdictBadgeVerdict): VerdictState {
	if (verdict === undefined) return "none";
	if (verdict === "pass") return "pass";
	return "fail";
}

export interface VerdictBadgeProps {
	verdict: VerdictBadgeVerdict;
	reason?: string;
	/**
	 * Display-ready string, already formatted by the caller. This component
	 * performs NO date formatting: the app's only formatter,
	 * app's only date-display helper (in `utils/displayUtils`) takes epoch-ms
	 * `number`, and the D-03 column is an ISO-Z `string`. Inventing an ISO
	 * formatter here is out of scope for this plan.
	 */
	verifiedAt?: string;
	testIDPrefix?: string;
}

export function VerdictBadge({ verdict, reason, verifiedAt, testIDPrefix = "verdict-badge" }: VerdictBadgeProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);

	const state = resolveVerdictState(verdict);

	let glyphName: string;
	let stateColor: string;
	let labelKey: string;

	if (state === "pass") {
		glyphName = "circle-check";
		stateColor = colors.success;
		labelKey = "attestationVerdictPass";
	} else if (state === "fail") {
		glyphName = "circle-xmark";
		stateColor = colors.error;
		labelKey = "attestationVerdictFail";
	} else {
		glyphName = "circle-question";
		stateColor = colors.textSecondary;
		labelKey = "attestationVerdictNone";
	}

	// The reason string is verifier-authored diagnostic text produced by
	// PlayIntegrityVerifier — it is explicitly NOT RegistrantPrivate data
	// (47-UI-SPEC.md:483-486), so the phase's never-render-values rule does
	// not apply to it. Do NOT "fix" this into a masked/tap-to-reveal treatment.
	const hasReason = state === "fail" && (reason ?? "").trim().length > 0;

	const pill = (
		<View
			testID={`${testIDPrefix}-${state}`}
			style={[pillStyles.pill, { backgroundColor: tintPill(stateColor) }]}
		>
			<FontAwesome6 name={glyphName} size={14} color={stateColor} />
			<ThemedText type="smallBold" style={{ color: stateColor }}>
				{t(labelKey)}
			</ThemedText>
		</View>
	);

	return (
		<View testID={testIDPrefix}>
			{hasReason ? (
				<TouchableOpacity onPress={() => setExpanded((e) => !e)}>{pill}</TouchableOpacity>
			) : (
				pill
			)}

			{hasReason && expanded && (
				<View testID={`${testIDPrefix}-reason`}>
					<ThemedText type="tiny" style={{ color: colors.textSecondary }}>
						{t("attestationVerdictReasonLabel")}
					</ThemedText>
					<ThemedText type="small" style={{ color: colors.text }}>
						{reason}
					</ThemedText>
					{verifiedAt !== undefined && (
						<ThemedText type="tiny" style={{ color: colors.textSecondary }}>
							{t("attestationVerdictVerifiedAtLabel")} {verifiedAt}
						</ThemedText>
					)}
				</View>
			)}
		</View>
	);
}
