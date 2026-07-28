import { useLayoutEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { INetworkEngine } from "@votetorrent/vote-core";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";

export default function ProposedRevisionScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation =
		useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { name, revision } = useRoute()
		.params as RootStackParamList["ProposedRevision"];
	const { getEngine } = useApp();

	const [loading, setLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>("");

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedRevisionTitle") });
	}, [navigation, t]);

	const onResendRequest = async () => {
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<INetworkEngine>("network");
			await engine.resendRevision(name, revision);
			navigation.goBack();
		} catch (err) {
			console.warn("proposedRevision-resendRequest error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const onCancelRequest = async () => {
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<INetworkEngine>("network");
			await engine.cancelRevision(name, revision);
			navigation.goBack();
		} catch (err) {
			console.warn("proposedRevision-cancelRequest error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedRevisionBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedRevisionBodySecondary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<InlineError message={errorMessage} />
				</View>
			</ScrollView>
			<Footer row>
				<CustomButton
					title={t("proposedRevisionResendRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading}
					onPress={onResendRequest}
				/>
				<CustomButton
					title={t("proposedRevisionCancelRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading}
					onPress={onCancelRequest}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
