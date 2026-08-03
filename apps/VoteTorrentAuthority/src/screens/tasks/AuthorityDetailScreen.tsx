import { useLayoutEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { IAuthorityEngine } from "@votetorrent/vote-core";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";

export default function AuthorityDetailScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation =
		useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { authorityId, slotCid } = useRoute()
		.params as RootStackParamList["AuthorityDetail"];
	const { getEngine } = useApp();

	const [loading, setLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>("");

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("authorityDetailTitle") });
	}, [navigation, t]);

	const onResend = async () => {
		if (loading) return; // re-entrancy guard: prevent concurrent engine calls on rapid double-press
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<IAuthorityEngine>("authority", authorityId);
			await engine.resendInvite(slotCid);
			navigation.goBack();
		} catch (err) {
			console.warn("authorityDetail-resend error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const onCancelInvitation = async () => {
		if (loading) return; // re-entrancy guard: prevent concurrent engine calls on rapid double-press
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<IAuthorityEngine>("authority", authorityId);
			await engine.cancelInvite(slotCid);
			navigation.goBack();
		} catch (err) {
			console.warn("authorityDetail-cancelInvitation error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodySecondary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<InlineError message={errorMessage} />
				</View>
			</ScrollView>
			<Footer row>
				<CustomButton
					title={t("authorityDetailResend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading}
					onPress={onResend}
				/>
				<CustomButton
					title={t("authorityDetailCancelInvitation")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading}
					onPress={onCancelInvitation}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
