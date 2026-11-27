import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import type { IntakeEngine } from "@votetorrent/vote-engine/rn";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { InlineError } from "../../../components/InlineError";
import { useApp } from "../../../providers/AppProvider";
import type { RootStackParamList } from "../../../navigation/types";

/**
 * ReassociationReviewNote — a READ-ONLY view of the per-authority device-change review setting
 * (D-46). The setting is per-authority (`AuthorityIntakePolicy`), so it is edited on the
 * authority's Registration Requests screen (user ruling 2026-10-07); an election's screen only
 * shows the current value and a button to get there. This component performs no write.
 *
 * An unreadable policy shows the load-error copy and NO value: a guessed mode would be dishonest.
 * No console calls, and no engine message is ever rendered.
 */

type Mode = "manual" | "automatic";

export function ReassociationReviewNote({ authorityId }: { authorityId: string }) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	const [mode, setMode] = useState<Mode | undefined>(undefined);
	const [unreadable, setUnreadable] = useState(false);
	const unmountedRef = useRef(false);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	useEffect(() => {
		void (async () => {
			try {
				const intake = await getEngine<IntakeEngine>("intake");
				const view = await intake.readIntakePolicy(authorityId);
				if (unmountedRef.current) return;
				setMode(view.reassociationMode);
				setUnreadable(false);
			} catch {
				if (unmountedRef.current) return;
				setMode(undefined);
				setUnreadable(true);
			}
		})();
	}, [getEngine, authorityId]);

	const modeLabel =
		mode === undefined
			? undefined
			: t(mode === "automatic" ? "registrationPolicyReassociationAutomatic" : "registrationPolicyReassociationManual");

	return (
		<View testID="reassociation-review-note">
			<ThemedText type="defaultSemiBold" testID="reassociation-review-note-heading">
				{t("registrationPolicyReassociationHeading")}
			</ThemedText>
			<ThemedText type="small" style={{ color: colors.textSecondary }}>
				{t("reassociationReviewAuthorityWide")}
			</ThemedText>
			{modeLabel !== undefined ? (
				<ThemedText type="default" testID="reassociation-review-note-current">
					{t("reassociationReviewNoteCurrent", { value: modeLabel })}
				</ThemedText>
			) : null}
			{unreadable ? <InlineError message={t("registrationPolicyReassociationLoadError")} /> : null}
			<ThemedText type="small" style={{ color: colors.textSecondary }}>
				{t("reassociationReviewNoteWhere", { screen: t("registrationRequestScreenTitle") })}
			</ThemedText>
			<CustomButton
				testID="reassociation-review-note-open"
				size="thin"
				title={t("registrationRequestScreenTitle")}
				onPress={() => navigation.navigate("RegistrationInbox", { authorityId })}
			/>
		</View>
	);
}
