/**
 * AddDeviceScreen — "Connect to existing user": shows the connection details (multiaddress +
 * one-time token) another device uses to join this user.
 *
 * The details come from the REAL `IUserEngine.connectDevice()` — never hardcoded values. That
 * engine call is phase-gated today (UKEY-04: same-user second-device pairing needs the P2P
 * device-enrollment flow) and throws `FeatureNotAvailableError`, so this screen currently renders
 * an honest "not available yet" state. It shows real details automatically once the engine
 * implements the call.
 *
 * There is deliberately no "Device Added" confirmation: pressing Done here proves nothing about
 * another device. A real confirmation needs an engine signal that the other device's key was
 * registered, which does not exist yet.
 */
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { useTheme, ExtendedTheme } from "@react-navigation/native";
import { FeatureNotAvailableError } from "@votetorrent/vote-core";
import type { DeviceAdvertisement, IUserEngine } from "@votetorrent/vote-core";
import { useApp } from "../../providers/AppProvider";

type ScreenState =
	| { kind: "loading" }
	| { kind: "ready"; advertisement: DeviceAdvertisement }
	| { kind: "unavailable" }
	| { kind: "noUser" }
	| { kind: "failed" };

/** `instanceof` alone can miss when two copies of vote-core are bundled; the name is the contract. */
function isFeatureNotAvailable(err: unknown): boolean {
	return err instanceof FeatureNotAvailableError || (err as { name?: unknown } | null)?.name === "FeatureNotAvailableError";
}

export function AddDeviceScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const [state, setState] = useState<ScreenState>({ kind: "loading" });

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const userEngine = await getEngine<IUserEngine>("user");
				// No user engine means no user is bound to the session on this network — a distinct,
				// explainable state, not an engine failure (it used to surface as a TypeError and the
				// generic "make sure a network is selected" copy while a network WAS selected).
				if (!userEngine) {
					if (live) setState({ kind: "noUser" });
					return;
				}
				const advertisement = await userEngine.connectDevice();
				if (live) setState({ kind: "ready", advertisement });
			} catch (err) {
				if (!live) return;
				if (isFeatureNotAvailable(err)) {
					setState({ kind: "unavailable" });
				} else {
					console.warn("AddDeviceScreen: connectDevice failed:", err);
					setState({ kind: "failed" });
				}
			}
		})();
		return () => {
			live = false;
		};
	}, [getEngine]);

	return (
		<View style={styles.content}>
			<ScrollView style={styles.content} contentContainerStyle={styles.container}>
				{state.kind === "loading" ? <ThemedText>{t("loading")}</ThemedText> : null}
				{state.kind === "unavailable" ? (
					<ThemedText testID="add-device-unavailable">{t("connectDeviceUnavailable")}</ThemedText>
				) : null}
				{state.kind === "noUser" ? (
					<ThemedText testID="add-device-no-user">{t("connectDeviceNoUser")}</ThemedText>
				) : null}
				{state.kind === "failed" ? (
					<ThemedText testID="add-device-failed">{t("connectDeviceFailed")}</ThemedText>
				) : null}
				{state.kind === "ready" ? (
					<>
						<ThemedText type="defaultSemiBold">{t("qrInformation")}:</ThemedText>
						<View style={[styles.section, styles.detailContainer]}>
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("multiaddress")}:</ThemedText>
								<ThemedText style={styles.valueText} numberOfLines={2} ellipsizeMode="middle">
									{state.advertisement.multiAddress}
								</ThemedText>
							</View>
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("token")}:</ThemedText>
								<ThemedText>{state.advertisement.token}</ThemedText>
							</View>
						</View>
						<ThemedText type="default">{t("fromOtherDevice")}</ThemedText>
					</>
				) : null}
			</ScrollView>
			<Footer>
				<CustomButton title={t("done")} icon="check" backgroundColor={colors.success} onPress={() => navigation.goBack()} />
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		marginLeft: 8,
	},
	detail: {
		flexDirection: "row",
		gap: 4,
	},
	valueText: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default AddDeviceScreen;
