import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { AuthorityIntakePolicyView, IntakeEngine } from "@votetorrent/vote-engine/rn";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { InlineError } from "../../../components/InlineError";
import { useApp } from "../../../providers/AppProvider";
import { createDeviceSigner } from "../../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../../hooks/useDeviceSigningErrorHandler";
import { isThresholdCoSignRefusal } from "../../registration/continuity-review";

/**
 * ReassociationReviewToggle — Surface 4 settings (D-46). It lives on the authority-level
 * Registration Requests screen, beside the device-change queue it governs (user ruling
 * 2026-10-07); an election's Registration Policy screen shows a read-only note instead
 * (ReassociationReviewNote). Whether a voter's device-change request
 * is reviewed by an officer ('manual', the default) or processed like a first device
 * ('automatic'). A radio pair, never a switch: both options are always visible, so an officer
 * reads the whole choice without toggling anything.
 *
 * Per-authority, written as a signed `AuthorityIntakePolicy` row through
 * `IntakeEngine.setIntakePolicy` (62-14), carrying `expectedRevision` so a concurrent change is
 * refused rather than overwritten. The write refuses `threshold-requires-co-sign` above a vrg
 * threshold of 1 (the 62-13 GAP): the control claims no multi-officer support, and renders that
 * refusal through its own copy with both options disabled.
 *
 * The scope gate (`canWrite`) is UI legibility only; the 'vrg' AdminSigning CHECK enforces it.
 * Disabled, never hidden.
 *
 * First render is 'manual' (the UI-SPEC default), but an unreadable policy selects NOTHING:
 * claiming a mode it could not read would be dishonest.
 *
 * No console calls, and no engine message is ever rendered.
 */

type Phase = "loading" | "ready" | "unreadable";
type Notice = "none" | "co-sign" | "save-error" | "load-error";

const NOTICE_KEY: Record<Exclude<Notice, "none">, string> = {
	"co-sign": "registrationPolicyReassociationCoSignRequired",
	"save-error": "registrationPolicyReassociationSaveError",
	"load-error": "registrationPolicyReassociationLoadError",
};

export interface ReassociationReviewToggleProps {
	authorityId: string;
	canWrite: boolean;
	testIDPrefix?: string;
}

export function ReassociationReviewToggle({
	authorityId,
	canWrite,
	testIDPrefix = "reassociation-review-toggle",
}: ReassociationReviewToggleProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [view, setView] = useState<AuthorityIntakePolicyView | undefined>(undefined);
	const [phase, setPhase] = useState<Phase>("loading");
	const [refused, setRefused] = useState(false);
	const [notice, setNotice] = useState<Notice>("none");
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const unmountedRef = useRef(false);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	/** Resolves true when the policy was read; a good read clears a stale load-error notice. */
	const read = useCallback(async (): Promise<boolean> => {
		try {
			const intake = await getEngine<IntakeEngine>("intake");
			const next = await intake.readIntakePolicy(authorityId);
			if (unmountedRef.current) return false;
			setView(next);
			setPhase("ready");
			setNotice((n) => (n === "load-error" ? "none" : n));
			return true;
		} catch {
			if (unmountedRef.current) return false;
			setPhase("unreadable");
			setNotice("load-error");
			return false;
		}
	}, [getEngine, authorityId]);

	const retryingRef = useRef(false);
	async function retry() {
		if (retryingRef.current) return;
		retryingRef.current = true;
		try {
			await read();
		} finally {
			retryingRef.current = false;
		}
	}

	useEffect(() => {
		void read();
	}, [read]);

	const selected: "manual" | "automatic" | undefined =
		phase === "loading" ? "manual" : phase === "ready" ? view?.reassociationMode : undefined;
	const disabled = !canWrite || phase !== "ready" || refused || submitting;

	async function choose(next: "manual" | "automatic") {
		if (submittingRef.current || disabled || view === undefined || next === selected) return;
		submittingRef.current = true;
		setSubmitting(true);
		setNotice("none");
		try {
			const intake = await getEngine<IntakeEngine>("intake");
			const signer = await createDeviceSigner("Device User");
			const written = await intake.setIntakePolicy(
				{ authorityId, reassociationMode: next, expectedRevision: view.revision },
				signer,
			);
			if (!unmountedRef.current) setView(written);
		} catch (err) {
			if (unmountedRef.current) return;
			if (isThresholdCoSignRefusal(err)) {
				// Never the engine message, and never "try again": retrying cannot succeed.
				setRefused(true);
				setNotice("co-sign");
			} else if ((err as { code?: unknown } | null)?.code === "policy-revision-conflict") {
				// save-error only when the re-read succeeded; a failed re-read leaves load-error + Retry.
				const reread = await read();
				if (reread && !unmountedRef.current) setNotice("save-error");
			} else {
				const outcome = handleDeviceSigningError(err);
				if (!outcome.handled) setNotice("save-error");
			}
		} finally {
			submittingRef.current = false;
			if (!unmountedRef.current) setSubmitting(false);
		}
	}

	const options: Array<{ mode: "manual" | "automatic"; labelKey: string }> = [
		{ mode: "manual", labelKey: "registrationPolicyReassociationManual" },
		{ mode: "automatic", labelKey: "registrationPolicyReassociationAutomatic" },
	];

	return (
		<View testID={testIDPrefix}>
			<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-heading`}>
				{t("registrationPolicyReassociationHeading")}
			</ThemedText>
			{options.map(({ mode, labelKey }) => {
				const isSelected = selected === mode;
				return (
					<TouchableOpacity
						key={mode}
						testID={`${testIDPrefix}-${mode}`}
						accessibilityRole="radio"
						accessibilityState={{ selected: isSelected, disabled }}
						disabled={disabled}
						onPress={() => void choose(mode)}
						style={[localStyles.option, disabled ? localStyles.optionDisabled : undefined]}
					>
						<FontAwesome6
							name={isSelected ? "circle-dot" : "circle"}
							size={20}
							color={isSelected ? colors.accent : colors.textSecondary}
						/>
						<ThemedText type="default" style={localStyles.optionLabel}>
							{t(labelKey)}
						</ThemedText>
					</TouchableOpacity>
				);
			})}
			<ThemedText type="small" style={{ color: colors.textSecondary }} testID={`${testIDPrefix}-default-note`}>
				{t("registrationPolicyReassociationDefaultNote")}
			</ThemedText>
			{notice !== "none" ? (
				<View testID={`${testIDPrefix}-notice`}>
					<InlineError message={t(NOTICE_KEY[notice])} />
				</View>
			) : null}
			{phase === "unreadable" ? (
				<CustomButton testID={`${testIDPrefix}-retry`} size="thin" title={t("loadRetryButton")} onPress={() => void retry()} />
			) : null}
		</View>
	);
}

const localStyles = StyleSheet.create({
	// Radio rows: 44 pt minimum touch target, stretched, label wraps, no line limit.
	option: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "stretch",
		minHeight: 44,
		gap: 8,
	},
	optionDisabled: {
		opacity: 0.6,
	},
	optionLabel: {
		flexShrink: 1,
	},
});
