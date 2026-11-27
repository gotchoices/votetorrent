import React from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import type { OfficerIntakeKeyState } from "../officer-intake-key";

/**
 * OfficerIntakeKeyCard — Phase 62 Plan 21 (D-04). A gap surface the 62-UI-SPEC does not cover
 * (Group J, `officerIntakeKey*`): the officer's "enable encrypted intake" registration step.
 *
 * Discretion record: accent is used as the primary non-destructive action (this card's only write
 * control, and not a 62-UI-SPEC-reserved role here); success colour is deliberately NOT used for
 * the 'enabled' confirmation text (reserved by the UI-SPEC elsewhere) — `textSecondary` instead.
 */

const NOOP = () => {};

interface OfficerIntakeKeyCardProps {
	state: "loading" | OfficerIntakeKeyState;
	disabled?: boolean;
	submitting?: boolean;
	showError?: boolean;
	errorMessage?: string;
	onEnable: () => void;
}

export function OfficerIntakeKeyCard({
	state,
	disabled = false,
	submitting = false,
	showError = false,
	errorMessage,
	onEnable,
}: OfficerIntakeKeyCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const buttonDisabled = disabled || submitting || state === "loading";

	return (
		<View testID="officer-intake-key-card" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
			<ThemedText type="defaultSemiBold">{t("officerIntakeKeyHeading")}</ThemedText>

			{state === "enabled" || state === "enabled-contested" ? (
				<>
					<ThemedText
						type="default"
						style={[localStyles.body, { color: colors.textSecondary }]}
						testID="officer-intake-key-enabled"
					>
						{t("officerIntakeKeyEnabledConfirm")}
					</ThemedText>
					{state === "enabled-contested" && (
						<View testID="officer-intake-key-contested">
							<InlineError message={t("officerIntakeKeyContestedWarning")} />
						</View>
					)}
				</>
			) : (
				<>
					<ThemedText type="default" style={localStyles.body}>
						{t("officerIntakeKeyBody")}
					</ThemedText>
					<View testID="officer-intake-key-enable" style={localStyles.footer}>
						<CustomButton
							title={t("officerIntakeKeyEnableButton")}
							backgroundColor={colors.accent}
							size="thin"
							disabled={buttonDisabled}
							onPress={buttonDisabled ? NOOP : onEnable}
						/>
					</View>
				</>
			)}

			{showError && (
				<View testID="officer-intake-key-error">
					<InlineError message={errorMessage ?? t("officerIntakeKeyError")} />
				</View>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	body: {
		marginTop: 8,
	},
	footer: {
		marginTop: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
