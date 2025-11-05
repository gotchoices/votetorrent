import { View, ScrollView, StyleSheet, Image, TouchableOpacity } from "react-native";
import { globalStyles } from "../../theme/styles";
import {
	useRoute,
	useTheme,
	ExtendedTheme,
	useNavigation,
	useFocusEffect,
} from "@react-navigation/native";
import { User, IUserEngine, UserHistory } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { CustomButton } from "../../components/CustomButton";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useState, useCallback } from "react";
import { getKeyTypeDisplayName, formatDate } from "../../utils/displayUtils";
import HistoryEvent from "../../components/HistoryEvent";
import { asyncIterableToArray } from "../../utils/dataUtils";
import type { NavigationProp } from "../../navigation/types";

export function UserDetailsScreen() {
	const { user: initialUser, userEngine } = useRoute().params as {
		user: User;
		userEngine: IUserEngine;
	};
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();

	const [user, setUser] = useState<User>(initialUser);
	const [isLoadingUser, setIsLoadingUser] = useState(false);

	const [showHistory, setShowHistory] = useState(false);
	const [userHistoryList, setUserHistoryList] = useState<UserHistory[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);

	useFocusEffect(
		useCallback(() => {
			const fetchUserData = async () => {
				if (!initialUser?.id || !userEngine) return;

				setIsLoadingUser(true);
				try {
					const latestUser = await userEngine.getSummary();
					if (latestUser) {
						setUser(latestUser);
					} else {
						console.warn("User not found after refetch:", initialUser.id);
					}
				} catch (error) {
					console.error("Failed to fetch latest user data:", error);
				} finally {
					setIsLoadingUser(false);
				}
			};

			fetchUserData();
		}, [initialUser?.id, userEngine])
	);

	useFocusEffect(
		useCallback(() => {
			const fetchHistory = async () => {
				if (!initialUser?.id || !userEngine) return;

				setIsLoadingHistory(true);
				try {
					const historyIterable = await userEngine.getHistory(initialUser.id, true);
					const historyArray = await asyncIterableToArray(historyIterable);
					setUserHistoryList(historyArray);
				} catch (error) {
					console.error("Failed to fetch user history:", error);
				} finally {
					setIsLoadingHistory(false);
				}
			};

			fetchHistory();
		}, [initialUser?.id, userEngine])
	);

	const toggleHistory = () => {
		setShowHistory(!showHistory);
	};

	return (
		<ScrollView style={styles.container}>
			<View style={styles.imageContainer}>
				<Image source={{ uri: user.image?.url }} style={styles.image} />
			</View>

			<View style={[styles.section, styles.detailContainer]}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("id")}: </ThemedText>
					<ThemedText>{user.id}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText>{user.name}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("imageUrl")}: </ThemedText>
					<ThemedText style={styles.imageUrl} numberOfLines={1} ellipsizeMode="tail">
						{user.image?.url ?? "N/A"}
					</ThemedText>
				</View>
			</View>

			<View>
				<ThemedText type="subtitle" style={styles.activeKeysTitle}>
					{t("activeKeys", "Active Keys")}:{" "}
				</ThemedText>
				<View style={styles.keysListContainer}>
					{user.activeKeys.length > 0 ? (
						user.activeKeys.map((key, index) => (
							<View key={key.key || index} style={styles.keyRow}>
								<ThemedText style={styles.keyIdText} numberOfLines={1} ellipsizeMode="middle">
									{key.key}
								</ThemedText>
								<View style={styles.keyDetails}>
									<View style={styles.keyDetailRow}>
										<ThemedText type="tinyBold">{t("type")}: </ThemedText>
										<ThemedText type="tiny">{t(getKeyTypeDisplayName(key.type))}</ThemedText>
									</View>
									<View style={styles.keyDetailRow}>
										<ThemedText type="tinyBold">{t("expiration")}: </ThemedText>
										<ThemedText type="tiny">{formatDate(key.expiration)}</ThemedText>
									</View>
								</View>
							</View>
						))
					) : (
						<ThemedText style={styles.noKeysText}>No active keys found.</ThemedText>
					)}
				</View>
			</View>

			<View style={styles.section}>
				<CustomButton
					title={t("reviseUser")}
					size="thin"
					backgroundColor={colors.accent}
					icon="pencil"
					onPress={() => {
						navigation.navigate("ReviseUser", { user: user, userEngine: userEngine });
					}}
				/>
				<CustomButton
					title={t("addKey")}
					size="thin"
					backgroundColor={colors.accent}
					icon="key"
					onPress={() => {
						navigation.navigate("AddKey", { user: user, userEngine: userEngine });
					}}
				/>
				<CustomButton
					title={t("revokeKey")}
					size="thin"
					backgroundColor={colors.accent}
					icon="key"
					onPress={() => {
						navigation.navigate("RevokeKey", { user: user, userEngine: userEngine });
					}}
				/>
			</View>

			<TouchableOpacity style={styles.historyHeader} onPress={toggleHistory}>
				<FontAwesome6
					name={showHistory ? "chevron-down" : "chevron-right"}
					size={14}
					color={colors.text}
				/>
				<ThemedText type="title">{t("history")}</ThemedText>
			</TouchableOpacity>

			{showHistory && (
				<View style={styles.section}>
					{isLoadingHistory ? (
						<ThemedText>{t("loading", "Loading...")}</ThemedText>
					) : userHistoryList.length > 0 ? (
						userHistoryList.map((historyItem, index) => (
							<HistoryEvent key={index} userHistory={historyItem} />
						))
					) : (
						<ThemedText>{t("noHistoryFound", "No history found.")}</ThemedText>
					)}
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	activeKeysTitle: {
		marginBottom: 10,
		fontWeight: "bold",
		fontSize: 16,
	},
	keysListContainer: {
		marginTop: 5,
	},
	keyRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 8,
		paddingLeft: 12,
	},
	keyIdText: {
		flexShrink: 1,
		marginRight: 10,
	},
	keyDetails: {
		justifyContent: "space-between",
		alignItems: "flex-end",
		paddingTop: 4,
	},
	keyDetailRow: {
		flexDirection: "row",
		paddingBottom: 16,
	},
	noKeysText: {
		fontStyle: "italic",
		marginTop: 5,
	},
	imageContainer: {
		alignItems: "center",
		marginBottom: 20,
	},
	image: {
		width: 80,
		height: 80,
	},
	imageUrl: {
		flex: 1,
	},
	detailContainer: {
		width: "100%",
	},
	detail: {
		flexDirection: "row",
	},
	historyHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default UserDetailsScreen;
