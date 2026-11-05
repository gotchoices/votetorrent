/**
 * AcceptInvitationScreen - the paste-first entry to every invitation accept flow.
 *
 * Why this exists (UAT 62 test 10): no production route used to reach an accept screen. The only
 * entries were dev scaffolds that passed placeholder ids, so an invitee could not accept anything.
 * The invitee now pastes the share they were sent; this screen parses it and hands the SAME text (by one-shot token, never in route params) to
 * the role screen for the share's type, which resolves the invite slot itself. This screen makes no
 * engine call, so routing here is a convenience and the role screens re-check the type.
 *
 * Precondition: the role screens only find a slot whose row is present in this device's database.
 * Replication of an invite to a second device is a separate (P2P) concern.
 *
 * The pasted text holds a one-time secret, so nothing here logs it.
 */

import React, { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { parseInviteShare } from "./invite-share";
import { stashInviteShare } from "./invite-share-handoff";
import { InviteSharePasteField } from "./InviteSharePasteField";

const ROUTE_FOR_TYPE = {
	k: "KeyholderInvitation",
	of: "AdministratorInvitation",
	au: "AuthorityInvitation",
} as const;

export function AcceptInvitationScreen() {
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const [pasted, setPasted] = useState("");
	const [errorMessage, setErrorMessage] = useState("");

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("invitationAcceptTitle") });
	}, [navigation, t]);

	const onContinue = () => {
		setErrorMessage("");
		const share = parseInviteShare(pasted);
		if (!share?.type) {
			setErrorMessage(t("invitationAcceptMalformed"));
			return;
		}
		const route = ROUTE_FOR_TYPE[share.type as keyof typeof ROUTE_FOR_TYPE];
		if (!route) {
			setErrorMessage(t("invitationAcceptWrongType"));
			return;
		}
		// The share holds the invite private key: only an opaque one-shot token travels in params.
		const shareToken = stashInviteShare(pasted);
		setPasted("");
		navigation.replace(route, { mode: "accept", shareToken });
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("invitationAcceptTitle")}
					</ThemedText>
					<ThemedText>{t("invitationAcceptBody")}</ThemedText>
					<InviteSharePasteField
						testIDPrefix="accept-invitation"
						value={pasted}
						onChangeText={setPasted}
						placeholder={t("invitationAcceptPastePlaceholder")}
					/>
				</View>
			</ScrollView>
			<InlineError message={errorMessage} />
			<Footer>
				<CustomButton
					testID="accept-invitation-continue"
					title={t("invitationAcceptContinue")}
					icon="arrow-right"
					disabled={!pasted.trim()}
					onPress={onContinue}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
	);
}

const styles = { ...globalStyles, ...StyleSheet.create({}) };

export default AcceptInvitationScreen;
