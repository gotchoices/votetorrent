import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useTranslation } from "react-i18next";

/**
 * Leave guard for the invitation screens. After Send, the screen's local `shareText` state holds the
 * ONLY copy of the one-time invite material (it includes `invitePrivate`), so an accidental Back
 * would lose a minted invite for good. While `shareText` is set and has not been shared or copied,
 * leaving is blocked behind a confirm Alert. The returned callback marks the current text as shared;
 * it is tied to that text, so a different `shareText` is guarded again.
 */
export function useUnsharedInviteGuard(shareText: string): () => void {
	const navigation = useNavigation();
	const { t } = useTranslation();
	const [sharedText, setSharedText] = useState<string | undefined>();
	const active = !!shareText && sharedText !== shareText;

	usePreventRemove(active, ({ data }) => {
		Alert.alert(
			t("inviteLeaveUnsharedTitle"),
			t("inviteLeaveUnsharedMessage"),
			[
				{ text: t("inviteLeaveUnsharedStay"), style: "cancel" },
				{
					text: t("inviteLeaveUnsharedLeave"),
					style: "destructive",
					onPress: () => navigation.dispatch(data.action),
				},
			],
			{ cancelable: true },
		);
	});

	return useCallback(() => setSharedText(shareText), [shareText]);
}
