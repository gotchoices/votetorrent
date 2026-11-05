import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../../components/ThemedText";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { CustomButton } from "../../../components/CustomButton";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import { isSaveableBridgeUrl } from "../registration-bridge-config";

/**
 * RestBridgeConfigCard — Phase 62 Plan 25 (D-29, 62-UI-SPEC Surface 1).
 *
 * Discretion record:
 *   - Save uses `colors.accent` (the UI-SPEC's accent reservation for the bridge URL save
 *     action). The co-sign line and the saved confirmation use `textSecondary` — success colour
 *     is reserved elsewhere by the UI-SPEC and is never used here, including for 'saved'. Invalid
 *     and save-error lines use `colors.error`.
 *   - The co-sign state is TERMINAL for this mount: once `notice === 'co-sign-required'`, Save
 *     stays disabled and the field stays non-editable for the rest of the mount — the write is
 *     not supported at this authority's threshold, and nothing here should invite a retry that
 *     would just refuse identically again.
 *   - Controls are disabled, never hidden, and `disabled`/the scope gate are legibility controls
 *     only — the real boundary is the signed ceremony `setIntakePolicy` enforces downstream.
 *   - No line-clamp prop on any message Text, and no ancestor up to the card root fixes height,
 *     maxHeight or clips its content — every message must be free to wrap (KG1/KG2).
 *   - The card sits near the top of the scroll view (see `BulkImportSyncScreen.tsx`'s render
 *     order), so the field stays above the keyboard on edge-to-edge Android, where `adjustResize`
 *     is a no-op at targetSdk 35.
 */

export interface RestBridgeConfigCardProps {
	loading: boolean;
	savedUrl: string | null;
	notice?: "saved" | "save-error" | "co-sign-required";
	disabled?: boolean;
	submitting?: boolean;
	onSave: (url: string) => void;
}

const NOOP = () => {};

export function RestBridgeConfigCard({
	loading,
	savedUrl,
	notice,
	disabled = false,
	submitting = false,
	onSave,
}: RestBridgeConfigCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [draft, setDraft] = useState(savedUrl ?? "");

	// Seeded from `savedUrl` whenever it changes (K5) — e.g. after a successful save re-reads the
	// config, or on first load once the config arrives.
	useEffect(() => {
		setDraft(savedUrl ?? "");
	}, [savedUrl]);

	const trimmed = draft.trim();
	const isCoSignLocked = notice === "co-sign-required";
	const fieldDisabled = disabled || loading || isCoSignLocked;
	const showInvalid = trimmed.length > 0 && !isSaveableBridgeUrl(trimmed);
	const saveDisabled = disabled || loading || submitting || isCoSignLocked || !isSaveableBridgeUrl(trimmed);

	const handleSave = () => {
		if (saveDisabled) return;
		onSave(trimmed);
	};

	return (
		<View testID="rest-bridge-config-card" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
			<ThemedText type="defaultSemiBold">{t("registrationBridgeConfigHeading")}</ThemedText>

			<CustomTextInput
				testID="registration-bridge-config-url"
				title={t("registrationBridgeConfigUrlLabel")}
				placeholder={t("registrationBridgeConfigUrlPlaceholder")}
				value={draft}
				onChangeText={setDraft}
				editable={!fieldDisabled}
				autoCapitalize="none"
				autoCorrect={false}
				keyboardType="url"
				textContentType="URL"
				maxLength={2048}
			/>

			{showInvalid && (
				<View testID="registration-bridge-config-invalid">
					<ThemedText type="small" style={{ color: colors.error }}>
						{t("registrationBridgeConfigInvalidUrl")}
					</ThemedText>
				</View>
			)}

			<View testID="registration-bridge-config-save" style={localStyles.footer}>
				<CustomButton
					title={t("registrationBridgeConfigSaveButton")}
					backgroundColor={colors.accent}
					size="thin"
					disabled={saveDisabled}
					onPress={saveDisabled ? NOOP : handleSave}
				/>
			</View>

			{notice === "saved" && (
				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t("registrationBridgeConfigSavedConfirm")}
				</ThemedText>
			)}
			{notice === "save-error" && <InlineError message={t("registrationBridgeConfigSaveError")} />}
			{notice === "co-sign-required" && (
				<ThemedText type="default" style={{ color: colors.textSecondary }} testID="registration-bridge-config-co-sign">
					{t("registrationBridgeConfigCoSignRequired")}
				</ThemedText>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	footer: {
		marginTop: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
