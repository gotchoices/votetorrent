import { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTheme } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";

interface KeyholderCardParams {
	invitationStatus: InviteStatus<SentKeyholderInvite>;
	onPress?: () => void;
}

export function KeyholderCard({ invitationStatus, onPress }: KeyholderCardParams) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const determineStatus = (invitationStatus: InviteStatus<SentKeyholderInvite>) => {
		const sent = Boolean(invitationStatus.result);
		const status = sent ? t("sent") : t("unsent");
		const color = sent ? colors.success : colors.warning;

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
					{invitationStatus.invite?.name ?? "(unnamed)"}
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
