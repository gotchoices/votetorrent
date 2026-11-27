import { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTheme } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { KEYHOLDER_INVITE_STATE_META, keyholderInviteState } from "../../keyholder/keyholder-invite-status";

interface KeyholderCardParams {
	invitationStatus: InviteStatus<SentKeyholderInvite>;
	onPress?: () => void;
}

export function KeyholderCard({ invitationStatus, onPress }: KeyholderCardParams) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const determineStatus = (invitationStatus: InviteStatus<SentKeyholderInvite>) => {
		// `result` means the keyholder RESPONDED (accepted/declined), never that an invite was sent.
		const meta = KEYHOLDER_INVITE_STATE_META[keyholderInviteState(invitationStatus)];
		const status = t(meta.labelKey);
		const color = colors[meta.colorKey];

		return (
			<ThemedText type="defaultSemiBold" style={{ color }} numberOfLines={1}>
				{status}
			</ThemedText>
		);
	};

	return (
		<TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: colors.card }]}>
			<View style={styles.cardContent}>
				<ThemedText type="cardTitle" numberOfLines={1}>
					{invitationStatus.invite?.name ?? t("keyholderUnnamed")}
				</ThemedText>
				{determineStatus(invitationStatus)}
			</View>
			<FontAwesome6 name="chevron-right" size={20} color={colors.text} style={styles.icon} />
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	card: {
		...globalStyles.cardSurface,
		flexDirection: "row",
		alignItems: "center",
	},
	cardContent: {
		flex: 1,
		marginRight: 8,
		paddingRight: 8,
	},
	icon: {
		marginLeft: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
