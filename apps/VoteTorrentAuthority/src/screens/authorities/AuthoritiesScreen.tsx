import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { InfoCard } from "../../components/InfoCard";
import { CollapsibleSection } from "../../components/CollapsibleSection";
import { ThemedText } from "../../components/ThemedText";
import React, { useEffect, useState, useCallback } from "react";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import type { NavigationProp } from "../../navigation/types";
import type { Authority, INetworkEngine } from "@votetorrent/vote-core";
import { NoNetwork } from "../../components/NoNetwork";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";

export default function AuthoritiesScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { getEngine, hasNetwork } = useApp();

	const [searchText, setSearchText] = useState("");
	const [unpinnedAuthorities, setUnpinnedAuthorities] = useState<Authority[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [pinnedAuthorities, setPinnedAuthorities] = useState<Authority[]>([]);
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);

	const loadAuthorities = useCallback(async () => {
		if (!networkEngine) return;
		try {
			setIsLoading(true);
			const pinned = await networkEngine.getPinnedAuthorities();
			setPinnedAuthorities(pinned);

			const unpinnedCursor = await networkEngine.getAuthoritiesByName(searchText);
			setUnpinnedAuthorities(
				unpinnedCursor.buffer.filter(
					(a: Authority) => !pinned.some((p: Authority) => p.id === a.id)
				)
			);
		} catch (error) {
			console.error("Error loading authorities:", error);
		} finally {
			setIsLoading(false);
		}
	}, [networkEngine, searchText]);

	useEffect(() => {
		async function initializeNetworkEngine() {
			if (!hasNetwork) return;
			try {
				const engine = await getEngine<INetworkEngine>("network");
				setNetworkEngine(engine);
			} catch (error) {
				console.error("Failed to initialize network engine:", error);
			}
		}
		initializeNetworkEngine();
	}, [hasNetwork, getEngine]);

	// Header right intentionally NOT overridden — the Authorities tab inherits
	// the global circle-user account avatar from useTabHeaderOptions() to match
	// the Figma header. AuthorityInvitation(send) remains reachable via the
	// ScreenScaffoldsDebug dev route (authorityInvitationSend).

	useFocusEffect(
		useCallback(() => {
			loadAuthorities();
		}, [loadAuthorities])
	);

	const handlePinToggle = useCallback(
		async (authority: Authority) => {
			if (!networkEngine) return;
			try {
				const isPinned = pinnedAuthorities.some((a) => a.id === authority.id);

				if (isPinned) {
					await networkEngine.unpinAuthority(authority.id);
				} else {
					await networkEngine.pinAuthority(authority);
				}

				const [unpinnedCursor, pinned] = await Promise.all([
					networkEngine.getAuthoritiesByName(searchText),
					networkEngine.getPinnedAuthorities(),
				]);

				setPinnedAuthorities(pinned);
				setUnpinnedAuthorities(
					unpinnedCursor.buffer.filter(
						(a: Authority) => !pinned.some((p: Authority) => p.id === a.id)
					)
				);
			} catch (error) {
				console.error("Error toggling authority pin:", error);
			}
		},
		[networkEngine, pinnedAuthorities, searchText]
	);

	if (!hasNetwork || !networkEngine) {
		return <NoNetwork />;
	}

	if (isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	const bothListsEmpty =
		pinnedAuthorities.length === 0 && unpinnedAuthorities.length === 0;

	if (bothListsEmpty) {
		return (
			<View style={styles.emptyContainer}>
				<FontAwesome6
					name="building-columns"
					size={56}
					color={colors.textSecondary}
				/>
				<ThemedText type="title">{t("noAuthorities")}</ThemedText>
				<ThemedText style={{ color: colors.textSecondary }}>
					{t("noAuthoritiesHelper")}
				</ThemedText>
			</View>
		);
	}

	return (
		<ScrollView style={styles.container}>
			{pinnedAuthorities.length > 0 ? (
				pinnedAuthorities.map((authority: Authority) => (
					<InfoCard
						key={authority.id}
						title={authority.name}
						image={{ uri: authority.imageRef?.url || "" }}
						additionalInfo={[
							{ label: t("sid"), value: authority.id },
							{ label: t("domain"), value: authority.domainName },
						]}
						icon={"chevron-right"}
						onPress={() => {
							navigation.navigate("AuthorityDetails", {
								authority: authority,
							});
						}}
					/>
				))
			) : (
				<ThemedText style={styles.emptyText}>{t("noPinnedAuthorities")}</ThemedText>
			)}

			<CollapsibleSection
				title={t("find")}
				searchPlaceholder={t("filterAuthorities")}
				onSearch={setSearchText}
				defaultExpanded
			>
				{unpinnedAuthorities.length > 0 ? (
					unpinnedAuthorities.map((authority) => (
						<InfoCard
							key={authority.id}
							title={authority.name}
							image={{ uri: authority.imageRef?.url || "" }}
							additionalInfo={[
								{ label: t("sid"), value: authority.id },
								{ label: t("domain"), value: authority.domainName },
							]}
							icon={"thumbtack"}
							onPress={() => handlePinToggle(authority)}
						/>
					))
				) : (
					<ThemedText style={styles.emptyText}>{t("noAuthoritiesFound")}</ThemedText>
				)}
			</CollapsibleSection>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	emptyContainer: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		padding: 32,
		gap: 12,
	},
	emptyText: {
		textAlign: "center",
		marginVertical: 16,
		opacity: 0.7,
	},
});

const styles = { ...globalStyles, ...localStyles };
