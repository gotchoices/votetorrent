import { InvitationStatus, KeyholderInvitation } from "@votetorrent/vote-core";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTheme } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";

interface KeyholderCardParams {
	invitationStatus: InvitationStatus<KeyholderInvitation>;
	onPress?: () => void;
}

export function KeyholderCard({ invitationStatus, onPress }: KeyholderCardParams) {
	const { colors } = useTheme() as ExtendedTheme;

	const determineStatus = (invitationStatus: InvitationStatus<KeyholderInvitation>) => {
		let status = "Unsent";
		let color = colors.error;

		if (invitationStatus.sent) {
			if (invitationStatus.result) {
				if (invitationStatus.result.isAccepted) {
					status = "Accepted";
					color = colors.success;
				} else {
					status = "Rejected";
					color = colors.error;
				}
			} else {
				status = "Sent";
				color = colors.warning;
			}
		}

		return (
			<ThemedText type="default" style={{ color: color }} numberOfLines={1}>
				{status}
			</ThemedText>
		);
	};

	return (
		<TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: colors.card }]}>
			<View style={styles.cardContent}>
				<ThemedText type="subtitle" numberOfLines={1}>
					{invitationStatus.slot.invite.slot.invite.name}
				</ThemedText>
				{determineStatus(invitationStatus)}
			</View>
			<FontAwesome6 name="chevron-right" size={16} color={colors.text} style={styles.icon} />
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	card: {
		flexDirection: "row",
		alignItems: "center",
		padding: 12,
		marginVertical: 8,
		marginHorizontal: 4,
		borderRadius: 12,
		shadowColor: "#000",
		shadowOffset: {
			width: 0,
			height: 2,
		},
		shadowOpacity: 0.1,
		shadowRadius: 4,
		elevation: 3,
	},
	cardContent: {
		flex: 1,
		marginLeft: 16,
		marginRight: 8,
		paddingRight: 16,
	},
	icon: {
		marginLeft: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
