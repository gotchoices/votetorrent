import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomButton } from "./CustomButton";
import { Footer } from "./Footer";

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
		<Footer row>
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
		</Footer>
	);
}
