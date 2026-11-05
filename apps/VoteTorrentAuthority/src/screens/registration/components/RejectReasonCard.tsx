import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";

/**
 * RejectReasonCard — the D-06 reject-reason confirmation card.
 *
 * Purpose: a rejection is a signed, irreversible, permanently-attributable
 * write (48-12). This card is the last point at which the act is still
 * cancellable, and the only place the officer is told what a rejection
 * *means* before they make one. Its gate is a non-empty trimmed reason — a
 * rejection with no reason defeats D-06 entirely: the applicant cannot be
 * told why, a re-application carries nothing, and the transparency
 * statistic means nothing.
 *
 * This is deliberately NOT a `LifecycleConfirmCard` variant. The two cards
 * share mechanics (the double-press guard, the three-state submit latch,
 * the button-row geometry) but not gate semantics — `LifecycleConfirmCard`'s
 * typed-name gate predicate answers "did the officer type the exact
 * registrant name", this card's `isRejectReasonValid` answers "did the
 * officer write anything at all". Overloading one gate with the other's
 * semantic is exactly how two distinct safeguards silently collapse into
 * one, so this file shares no source with `LifecycleConfirmCard.tsx` and
 * that file is not modified by this component's existence.
 *
 * Divergence from `LifecycleConfirmCard`, deliberate: this card resolves its
 * own copy via `useTranslation()` rather than receiving resolved strings as
 * props. `LifecycleConfirmCard` takes copy as props because eight call sites
 * bind eight different key sets; this card binds exactly ONE fixed key group
 * (`registrationRequestReject*`), so resolving in-place puts the key binding
 * itself under test. Data (the requester's display name) still arrives as a
 * prop.
 *
 * Purely presentational: props in, callbacks out. No engine call, no
 * navigation, no import from `vote-engine` or the engines layer.
 */

// A stable no-op for the (non-optional) CustomButton.onPress prop when a
// gate is unmet — belt-and-suspenders alongside `disabled` so no callback
// can fire even from a direct programmatic invocation of the handler, not
// just from a blocked touch event. Declared locally rather than imported
// from `LifecycleConfirmCard` (which exports it as neither a named nor
// default export) — reaching into that file would couple the two
// components this plan exists to keep separate.
const NOOP = () => {};

/**
 * The D-06 reject-reason gate. Deliberately narrow — the ONLY question this
 * predicate answers is "is there any reason text at all":
 *
 * - Non-empty after trimming -> true.
 * - Empty, or whitespace-only -> false.
 *
 * Prohibited widenings: no minimum-length requirement beyond non-empty, no
 * profanity or content filter, no normalization, no locale-sensitive
 * folding. Above all, this must NOT be replaced by, aliased to, or routed
 * through `LifecycleConfirmCard`'s typed-name gate predicate — that gate
 * asks whether typed text matches an expected name; this gate asks whether
 * typed text exists at all. The two answer different questions and must be
 * able to change independently.
 */
export function isRejectReasonValid(reason: string): boolean {
	return reason.trim().length > 0;
}

type SubmitState = "idle" | "submitting" | "submitted";

export interface RejectReasonCardProps {
	/**
	 * The display name interpolated into the body copy. Comes from the
	 * owning screen's already-resolved display helper
	 * (`registrationRequestDisplayName`). This value is attacker-influenced
	 * request-payload content and must therefore never reach `console.*`,
	 * an `Error` message, or any crash payload from inside this component.
	 */
	requesterName: string;
	/** Receives the TRIMMED reason — trimming happens here, once, so no caller can persist a reason that passed the gate on whitespace it then stored. */
	onConfirm: (reason: string) => void | Promise<void>;
	onDismiss: () => void;
	/**
	 * The D-07 checklist gate state, owned by the host. The engine refuses an
	 * ungated reject (WR-02); this mirrors it so Confirm Rejection cannot be
	 * pressed (and no biometric prompt spent) while the checklist is unmet.
	 */
	decisionGateMet: boolean;
	/**
	 * Defaults to `"reject-reason"`, which resolves the rendered testIDs to
	 * `reject-reason-card`, `reject-reason-title`, `reject-reason-body`,
	 * `reject-reason-reason-input`, `reject-reason-confirm`, and
	 * `reject-reason-dismiss`.
	 */
	testIDPrefix?: string;
	/**
	 * Failure copy owned by the host, shown inside the card above the buttons so a failed
	 * confirmation is visible next to the control just pressed (UAT 62 gap 4 item 1). The card
	 * only displays what it is given; it never derives copy from a caught error.
	 */
	errorMessage?: string;
}

export function RejectReasonCard({
	requesterName,
	onConfirm,
	onDismiss,
	decisionGateMet,
	testIDPrefix = "reject-reason",
	errorMessage,
}: RejectReasonCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const [reasonValue, setReasonValue] = useState("");
	const [submitState, setSubmitState] = useState<SubmitState>("idle");
	// `submitState` alone is NOT sufficient to guard against a rapid
	// multi-press: two touch events dispatched within the same JS tick both
	// read the SAME closure's `submitState` (React does not re-render
	// synchronously between them), so a `useState`-only guard can still let
	// a second call through before the first `setSubmitState("submitting")`
	// has taken effect. This app has already shipped double-press defects
	// on signed writes, and a doubled reject fires two signed, permanent,
	// non-retractable records. `submittingRef` closes that gap: a ref
	// mutation is synchronous and visible to every subsequent call in the
	// same tick, unlike a state update.
	const submittingRef = useRef(false);

	// Instance-reuse reset. A reason typed for one requester must never
	// carry into another rendered at the same element position without a
	// `key` — mirrors `LifecycleConfirmCard`'s reset effect.
	useEffect(() => {
		setReasonValue("");
	}, [requesterName, testIDPrefix]);

	const canConfirm = submitState === "idle" && decisionGateMet && isRejectReasonValid(reasonValue);

	// Three-state submit latch: idle -> submitting -> submitted. A resolved
	// submit latches permanently (the card's owner is expected to unmount it
	// on success); a rejected submit returns to idle so the officer can
	// retry rather than being stranded. `submittingRef` is checked and set
	// FIRST, synchronously, before any state update.
	async function handleConfirm() {
		if (submittingRef.current || submitState !== "idle" || !canConfirm) return;
		submittingRef.current = true;
		setSubmitState("submitting");
		try {
			await onConfirm(reasonValue.trim());
			setSubmitState("submitted");
		} catch {
			// The caught value is swallowed on purpose: the owning screen
			// (48-19) owns error presentation via `InlineError`, and a
			// rejected write's cause may embed request-payload content that
			// must never reach a log or a render from inside this component.
			submittingRef.current = false;
			setSubmitState("idle");
		}
	}

	// A dismissed confirmation performs ZERO engine work: this handler
	// invokes only `onDismiss`, never `onConfirm`, and never inspects or
	// clears `reasonValue`. While a confirm is in flight the dismiss control
	// is also disabled — the write cannot be recalled, so an enabled
	// dismiss would misrepresent the outcome.
	function handleDismiss() {
		if (submitState !== "idle") return;
		onDismiss();
	}

	return (
		<View
			testID={`${testIDPrefix}-card`}
			style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.error }]}
		>
			<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-title`}>
				{t("registrationRequestRejectTitle")}
			</ThemedText>
			{/*
			 * D-06's actual purpose, not a generic "are you sure": this body
			 * states the persistence / repudiation consequence — that a
			 * rejection is a permanent, attributable record shown to whoever
			 * reviews a re-application. Softening it to a bare confirmation
			 * would defeat the decision it implements.
			 */}
			<ThemedText type="default" testID={`${testIDPrefix}-body`}>
				{t("registrationRequestRejectBody", { name: requesterName })}
			</ThemedText>
			<CustomTextInput
				testID={`${testIDPrefix}-reason-input`}
				placeholder={t("registrationRequestRejectReasonPlaceholder")}
				value={reasonValue}
				onChangeText={setReasonValue}
				multiline
				// This is prose the officer writes, not an identifier being
				// matched (the opposite of `LifecycleConfirmCard`'s typed
				// input) — autoCorrect is left at its default rather than
				// disabled.
				autoCapitalize="sentences"
			/>
			{!decisionGateMet ? (
				<ThemedText type="small" testID={`${testIDPrefix}-gate-hint`} style={{ color: colors.textSecondary }}>
					{t("registrationRequestRejectChecklistRequired")}
				</ThemedText>
			) : null}
			{errorMessage ? (
				<View testID={`${testIDPrefix}-error`}>
					<InlineError message={errorMessage} />
				</View>
			) : null}
			<View style={localStyles.buttonRow}>
				<View testID={`${testIDPrefix}-dismiss`} style={localStyles.buttonSlot}>
					{/*
						 * Geometry: each slot is a ROW (see buttonSlot) so CustomButton's `flex`
						 * (flex:1 + alignSelf:stretch, built for a row parent) stretches the button to
						 * the row height instead of collapsing. In the earlier column-slot form it
						 * zeroed the vertical flex-basis: 32px on Pixel_8 (UAT 62 test 13). Dropping
						 * `flex` alone (62-52 first attempt) left a one-line thin button at its natural
						 * 36dp (95px measured on device) beside a 2-line neighbour: below the 44dp floor
						 * and uneven. The geometry gate is scripts/assert-card-button-geometry.mjs.
						 */}
					<CustomButton
						size="thin"
						flex
						title={t("registrationRequestRejectKeepReviewingButton")}
						backgroundColor={colors.accent}
						disabled={submitState !== "idle"}
						onPress={submitState === "idle" ? handleDismiss : NOOP}
					/>
				</View>
				<View testID={`${testIDPrefix}-confirm`} style={localStyles.buttonSlot}>
					{/*
						 * Geometry: each slot is a ROW (see buttonSlot) so CustomButton's `flex`
						 * (flex:1 + alignSelf:stretch, built for a row parent) stretches the button to
						 * the row height instead of collapsing. In the earlier column-slot form it
						 * zeroed the vertical flex-basis: 32px on Pixel_8 (UAT 62 test 13). Dropping
						 * `flex` alone (62-52 first attempt) left a one-line thin button at its natural
						 * 36dp (95px measured on device) beside a 2-line neighbour: below the 44dp floor
						 * and uneven. The geometry gate is scripts/assert-card-button-geometry.mjs.
						 */}
					<CustomButton
						size="thin"
						flex
						title={t("registrationRequestRejectConfirmButton")}
						backgroundColor={colors.error}
						disabled={!canConfirm}
						onPress={canConfirm ? handleConfirm : NOOP}
					/>
				</View>
			</View>
		</View>
	);
}

/** Minimum clickable height of a card button, dp (Android 48dp touch target). */
const BUTTON_MIN_HEIGHT = 48;
/** CustomButton styles.button.marginVertical, dp, each side. */
const BUTTON_MARGIN_VERTICAL = 8;

const localStyles = StyleSheet.create({
	buttonRow: {
		flexDirection: "row",
		alignItems: "stretch",
		gap: 8,
		marginTop: 8,
	},
	buttonSlot: {
		// Row direction on purpose: CustomButton's `flex` assumes a row parent (see the note at
		// each button). The slot still splits the row 50/50 via flex:1 + minWidth:0.
		flexDirection: "row",
		// Floor on the CLICKABLE button, not the slot: `flex` stretches the button to the slot
		// height MINUS CustomButton's own marginVertical (8 top + 8 bottom). A one-line thin
		// button is 36dp natural (95px on Pixel_8), so a bare 48 slot floor never bound (36 + 16
		// = 52 > 48) and the button stayed at 36dp. So the slot floor is 48dp of button plus the
		// margins. If CustomButton's marginVertical changes, update BUTTON_MARGIN_VERTICAL
		// (the jest structural pin reads the real margin and fails on a mismatch).
		minHeight: BUTTON_MIN_HEIGHT + 2 * BUTTON_MARGIN_VERTICAL,
		flex: 1,
		minWidth: 0,
	},
});

const styles = { ...globalStyles, ...localStyles };
