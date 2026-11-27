import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import type { NavigationProp } from "../../navigation/types";

// Phase 7 dev-entry route per D-12. Lists every scaffold screen so reviewers can
// reach all six before phases 8–10 wire the real callers.
// Temporary by design — remove once callers are wired upstream.
//
// Phase 8 gap-closure 08-07 Task 3: three additional entries for accept/send
// invitation modes (closes UAT tests 7 + 8 accept-mode reachability). A real
// Tasks/Inbox surface is deferred to a future milestone per scope_constraints.
//
// Phase 57 (T-57-16-05) — CORRECTION. The earlier note here claimed
// MockInvitationEngine returns a seeded invite for any id. That is STALE:
// engine-factory.ts `case 'invitations'` returns a real InvitationEngine with
// no dev branch, so the send modes reach real signing (createDeviceSigner →
// saveInviteWithSigning). The accept entries below are paste-first since UAT 62
// test 10 (no route id is passed), and accept is also reachable in production via
// Settings -> Accept an Invitation. This screen and its route are
// now dev-only: the Settings entry sits inside `__DEV__` and the route is
// registered through a `__DEV__`-guarded require, so this module is absent
// from release bundles (verified by bundle grep + negative control).
type FrameRoute = {
	key: string;
	route: string;
	titleKey: string;
	params?: Record<string, unknown>;
};

const FRAME_ROUTES: ReadonlyArray<FrameRoute> = [
	{ key: "editElection",            route: "EditElection",            titleKey: "editElectionTitle" },
	{ key: "authorityDetail",         route: "AuthorityDetail",         titleKey: "authorityDetailTitle" },
	{ key: "editElectionWithFilter",  route: "EditElectionWithFilter",  titleKey: "editElectionWithFilterTitle" },
	{ key: "editRevisionForm",        route: "EditRevisionForm",        titleKey: "editRevisionFormTitle" },
	{ key: "proposedElection",        route: "ProposedElection",        titleKey: "proposedElectionTitle" },
	{ key: "proposedRevision",        route: "ProposedRevision",        titleKey: "proposedRevisionTitle" },
	{ key: "administratorInvitationAccept", route: "AdministratorInvitation", titleKey: "debugAdministratorInvitationAccept", params: { mode: "accept" } },
	{ key: "authorityInvitationSend",       route: "AuthorityInvitation",     titleKey: "debugAuthorityInvitationSend",       params: { mode: "send" } },
	{ key: "authorityInvitationAccept",     route: "AuthorityInvitation",     titleKey: "debugAuthorityInvitationAccept",     params: { mode: "accept" } },
	// Phase 10 plan 10-02 — Keyholder invitation dev entries (D-07 accept reachability, D-10 keep wrench)
	{ key: "keyholderInvitationSend",   route: "KeyholderInvitation", titleKey: "debugKeyholderInvitationSend",   params: { mode: "send" } },
	{ key: "keyholderInvitationAccept", route: "KeyholderInvitation", titleKey: "debugKeyholderInvitationAccept", params: { mode: "accept" } },
];

export default function ScreenScaffoldsDebugScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("screenScaffoldsDebugTitle") });
	}, [navigation, t]);

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("screenScaffoldsDebugIntro")}</ThemedText>
				</View>
				{FRAME_ROUTES.map((entry) => (
					<View key={entry.key} style={styles.section}>
						<CustomButton
							title={t(entry.titleKey)}
							backgroundColor={colors.accent}
							size="thin"
							onPress={() => {
								console.log(`screenScaffoldsDebug-navigate-${entry.route}`);
								navigation.navigate(entry.route as any, entry.params as any);
							}}
						/>
					</View>
				))}
			</ScrollView>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
