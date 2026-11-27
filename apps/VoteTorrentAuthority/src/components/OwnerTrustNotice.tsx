import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { useCadreNode } from "../providers/CadreNodeProvider";
import type { OwnerTrustState } from "../engines/owner-trust";

/**
 * The officer-facing signal for the three owner-trust states the cadre-node provider resolves at
 * boot (64-07):
 *   needs-reinvite (D-09): this phone no longer remembers which owners to trust on its network.
 *   memory-only    (D-10): the saved trusted-owner list could not be opened, so trust lasts until
 *                          the app closes. A log line is not enough, so this is on screen.
 *   blocked        (D-11): same failure with "Require saved owner trust" on, so nothing connected.
 *
 * Persistent and not dismissible: the component reads its own state from the cadre-node context
 * (no state prop, so no screen can override or spoof it), has no close control, and goes away only
 * when the context value becomes "ok". The provider resolves priority (blocked, then memory-only,
 * then needs-reinvite) into ONE value, so at most one notice shows. A missing value counts as "ok".
 *
 * The needs-reinvite action is the onNeedsReinvite prop, wired to the Join a network screen by the
 * screens (never to AcceptInvitation). Open Settings is the onOpenSettings prop; the Settings screen
 * does not pass it, because the setting row is already on that screen. The component logs nothing
 * and never touches the node.
 */
export interface OwnerTrustNoticeProps {
	onNeedsReinvite?: () => void;
	onOpenSettings?: () => void;
}

export type OwnerTrustNoticeState = "needs-reinvite" | "memory-only" | "blocked";

export function ownerTrustNoticeState(value: OwnerTrustState | undefined): OwnerTrustNoticeState | null {
	if (value === "needs-reinvite" || value === "memory-only" || value === "blocked") {
		return value;
	}
	return null;
}

interface NoticeSpec {
	border: "warning" | "error";
	icon: string;
	iconColor: "warningText" | "error";
	titleKey: string;
	bodyKey: string;
	action: "reinvite" | "settings";
}

const SPECS: Record<OwnerTrustNoticeState, NoticeSpec> = {
	"needs-reinvite": {
		border: "warning",
		icon: "triangle-exclamation",
		iconColor: "warningText",
		titleKey: "ownerTrustReinviteTitle",
		bodyKey: "ownerTrustReinviteBody",
		action: "reinvite",
	},
	"memory-only": {
		border: "warning",
		icon: "triangle-exclamation",
		iconColor: "warningText",
		titleKey: "ownerTrustMemoryTitle",
		bodyKey: "ownerTrustMemoryBody",
		action: "settings",
	},
	blocked: {
		border: "error",
		icon: "circle-exclamation",
		iconColor: "error",
		titleKey: "ownerTrustBlockedTitle",
		bodyKey: "ownerTrustBlockedBody",
		action: "settings",
	},
};

export function OwnerTrustNotice({ onNeedsReinvite, onOpenSettings }: OwnerTrustNoticeProps) {
	const { ownerTrust } = useCadreNode();
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const state = ownerTrustNoticeState(ownerTrust);
	if (state === null) {
		return null;
	}
	const spec = SPECS[state];

	return (
		<View
			testID="owner-trust-notice"
			accessibilityRole="alert"
			style={[styles.container, { borderColor: colors[spec.border], backgroundColor: colors.card }]}
		>
			<View testID={"owner-trust-notice-" + state} style={styles.content}>
				<View style={styles.header}>
					<FontAwesome6
						testID="owner-trust-notice-icon"
						name={spec.icon}
						size={16}
						color={colors[spec.iconColor]}
						accessible={false}
						importantForAccessibility="no"
					/>
					<ThemedText type="defaultSemiBold" testID="owner-trust-notice-title" style={styles.title}>
						{t(spec.titleKey)}
					</ThemedText>
				</View>
				<ThemedText type="small" testID="owner-trust-notice-body" style={{ color: colors.text }}>
					{t(spec.bodyKey)}
				</ThemedText>
				{spec.action === "reinvite" && onNeedsReinvite ? (
					<CustomButton
						size="tall"
						icon="right-to-bracket"
						title={t("ownerTrustReinviteAction")}
						testID="owner-trust-notice-needs-reinvite-action"
						onPress={onNeedsReinvite}
					/>
				) : null}
				{spec.action === "settings" && onOpenSettings ? (
					<CustomButton
						size="tall"
						icon="gear"
						title={t("ownerTrustOpenSettings")}
						testID={"owner-trust-notice-" + state + "-action"}
						onPress={onOpenSettings}
					/>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 16,
		marginBottom: 16,
	},
	content: {
		gap: 8,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
	},
	title: {
		flexShrink: 1,
	},
});
