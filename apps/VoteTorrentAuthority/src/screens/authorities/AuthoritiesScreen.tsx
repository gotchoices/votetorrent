import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { InfoCard } from "../../components/InfoCard";
import { CollapsibleSection } from "../../components/CollapsibleSection";
import { ThemedText } from "../../components/ThemedText";
import React, { useRef, useState, useCallback } from "react";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import type { NavigationProp } from "../../navigation/types";
import type { Authority, INetworkEngine } from "@votetorrent/vote-core";
import { NoNetwork } from "../../components/NoNetwork";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";
import { InlineError } from "../../components/InlineError";
import { PeerReadUnavailableNotice } from "../../components/PeerReadUnavailableNotice";
import { classifyPeerReadFailure } from "../../engines/peer-read-unavailable";

export default function AuthoritiesScreen() {
	const { t } = useTranslation();
	const tRef = useRef(t);
	tRef.current = t;
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { getEngine, hasNetwork } = useApp();

	const [searchText, setSearchText] = useState("");
	const [unpinnedAuthorities, setUnpinnedAuthorities] = useState<Authority[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [pinnedAuthorities, setPinnedAuthorities] = useState<Authority[]>([]);
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	// A read that could not reach the other devices: translated notice, never the engine message.
	const [peerUnavailable, setPeerUnavailable] = useState(false);

	// Sequences loads so a slower, superseded one (an earlier focus, or the previous network) never
	// overwrites a newer one.
	const loadSeqRef = useRef(0);

	const loadAuthorities = useCallback(async () => {
		if (!hasNetwork) return;
		const seq = ++loadSeqRef.current;
		const current = () => seq === loadSeqRef.current;
		setErrorMessage("");
		setPeerUnavailable(false);
		// Resolve the network engine on EVERY load, not once on mount. The factory builds a new engine
		// when the session switches network, and an engine held from mount kept reading the previous
		// network: its pinned card stayed and Find said "No authorities found" for the new network's
		// own authorities until a cold start (Session 1 Pixel_8 A-6).
		let engine: INetworkEngine;
		try {
			engine = await getEngine<INetworkEngine>("network");
		} catch (error) {
			if (!current()) return;
			console.warn("Failed to initialize network engine:", error);
			setNetworkEngine(null);
			setErrorMessage(tRef.current("authoritiesLoadFailed"));
			setIsLoading(false);
			return;
		}
		if (!current()) return;
		setNetworkEngine(engine);
		try {
			setIsLoading(true);
			const pinned = await engine.getPinnedAuthorities();
			if (!current()) return;
			setPinnedAuthorities(pinned);

			const unpinnedCursor = await engine.getAuthoritiesByName(searchText);
			if (!current()) return;
			setUnpinnedAuthorities(
				unpinnedCursor.buffer.filter(
					(a: Authority) => !pinned.some((p: Authority) => p.id === a.id)
				)
			);
		} catch (error) {
			if (!current()) return;
			const peerFailure = classifyPeerReadFailure(error);
			if (peerFailure) {
				console.warn("[authorities] peer read unavailable:", peerFailure.reason);
				setPeerUnavailable(true);
			} else {
				console.warn("Error loading authorities:", error);
				setErrorMessage(tRef.current("authoritiesLoadFailed"));
			}
		} finally {
			if (current()) setIsLoading(false);
		}
	}, [hasNetwork, getEngine, searchText]);

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
			setErrorMessage("");
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
				console.warn("Error toggling authority pin:", error);
				setErrorMessage(tRef.current("authorityPinFailed"));
			}
		},
		[networkEngine, pinnedAuthorities, searchText]
	);

	if (hasNetwork && !networkEngine && errorMessage) {
		// The network engine could not be opened: say so (translated) instead of the no-network state.
		return (
			<ScrollView style={styles.container}>
				<InlineError message={errorMessage} />
			</ScrollView>
		);
	}

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

	const notice = peerUnavailable ? (
		<PeerReadUnavailableNotice
			variant={pinnedAuthorities.length === 0 && unpinnedAuthorities.length === 0 ? "unavailable" : "stale"}
			onRetry={loadAuthorities}
		/>
	) : null;

	const bothListsEmpty =
		pinnedAuthorities.length === 0 && unpinnedAuthorities.length === 0;

	if (bothListsEmpty && (peerUnavailable || errorMessage)) {
		return (
			<ScrollView style={styles.container}>
				<InlineError message={errorMessage} />
				{notice}
			</ScrollView>
		);
	}

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
			<InlineError message={errorMessage} />
			{notice}
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
							onPress={() => {
								navigation.navigate("AuthorityDetails", {
									authority: authority,
								});
							}}
							onIconPress={() => handlePinToggle(authority)}
							iconAccessibilityLabel={t("pin")}
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
