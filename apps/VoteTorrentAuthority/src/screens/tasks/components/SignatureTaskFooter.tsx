import { View, StyleSheet } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomButton } from "../../../components/CustomButton";
import { globalStyles } from "../../../theme/styles";

export interface SignatureTaskFooterProps {
	onAccept: () => void;
	onReject: () => void;
	acceptLabel?: string;
	rejectLabel?: string;
}

export function SignatureTaskFooter({
	onAccept,
	onReject,
	acceptLabel,
	rejectLabel,
}: SignatureTaskFooterProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	return (
		<View
			style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
		>
			<CustomButton
				title={acceptLabel ?? t("accept")}
				icon="check"
				backgroundColor={colors.success}
				size="thin"
				flex={true}
				onPress={onAccept}
			/>
			<CustomButton
				title={rejectLabel ?? t("reject")}
				icon="xmark"
				backgroundColor={colors.error}
				size="thin"
				flex={true}
				onPress={onReject}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
