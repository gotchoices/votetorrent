/**
 * InviteSharePasteField - the paste field shared by the four invitation accept surfaces.
 *
 * The pasted share holds the invite PRIVATE key. Before it parses, the field is a secure
 * (masked, no keyboard learning) input. Once it parses, no readable field shows it: a masked
 * summary with a Clear button replaces the input. While a share is held the Android window is
 * FLAG_SECURE (blank screenshots / Recents), via a ref-counted lease so that a replace() from one
 * accept screen to another (both holding a share) never switches the flag off under the new one.
 *
 * The Authority has no other setSecureScreen caller today; any future caller must use the same
 * lease (acquireSecureLease / releaseSecureLease). Nothing here logs.
 */

import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { setSecureScreen } from "@votetorrent/attestation-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { parseInviteShare } from "./invite-share";

let leases = 0;

function setSecure(enabled: boolean): void {
	try {
		void Promise.resolve(setSecureScreen(enabled)).catch(() => undefined);
	} catch {
		// never throws into the UI
	}
}

export function acquireSecureLease(): void {
	leases += 1;
	if (leases === 1) setSecure(true);
}

export function releaseSecureLease(): void {
	if (leases === 0) return;
	leases -= 1;
	if (leases === 0) setSecure(false);
}

interface Props {
	value: string;
	onChangeText: (text: string) => void;
	title?: string;
	placeholder?: string;
	testIDPrefix: string;
}

const ROLE_KEYS: Record<string, string> = {
	of: "invitationRoleAdministrator",
	au: "invitationRoleAuthority",
	k: "invitationRoleKeyholder",
};

export function InviteSharePasteField({ value, onChangeText, title, placeholder, testIDPrefix }: Props) {
	const { t } = useTranslation();
	const parsed = parseInviteShare(value);
	const hasValue = value.trim().length > 0;

	useFocusEffect(
		useCallback(() => {
			if (!hasValue) return undefined;
			acquireSecureLease();
			return () => releaseSecureLease();
		}, [hasValue])
	);

	if (parsed) {
		const roleKey = parsed.type ? ROLE_KEYS[parsed.type] : undefined;
		const role = roleKey ? t(roleKey) : t("invitation");
		return (
			<View testID={`${testIDPrefix}-summary`} style={styles.summary}>
				{title ? <ThemedText type="defaultSemiBold">{title}</ThemedText> : null}
				<ThemedText>{t("invitationPastedSummary", { role })}</ThemedText>
				<CustomButton testID={`${testIDPrefix}-clear`} title={t("invitationPastedClear")} size="thin" onPress={() => onChangeText("")} />
			</View>
		);
	}

	return (
		<CustomTextInput
			testID={`${testIDPrefix}-input`}
			title={title}
			value={value}
			onChangeText={onChangeText}
			placeholder={placeholder}
			secureTextEntry
			autoCorrect={false}
			autoCapitalize="none"
			importantForAutofill="no"
		/>
	);
}

const styles = StyleSheet.create({
	summary: { gap: 8, marginTop: 8 },
});

export default InviteSharePasteField;
