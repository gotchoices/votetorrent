import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import type {
	SignatureTask,
	AdministrationSignatureTask,
	AuthoritySignatureTask,
	NetworkSignatureTask,
	ElectionSignatureTask,
	ElectionRevisionSignatureTask,
	BallotSignatureTask,
} from "@votetorrent/vote-core";
import { AdministrationSignatureTaskDetails } from "./components/AdministrationSignatureTaskDetails";
import { AuthoritySignatureTaskDetails } from "./components/AuthoritySignatureTaskDetails";
import { NetworkSignatureTaskDetails } from "./components/NetworkSignatureTaskDetails";
import { ElectionSignatureTaskDetails } from "./components/ElectionSignatureTaskDetails";
import { ElectionRevisionSignatureTaskDetails } from "./components/ElectionRevisionSignatureTaskDetails";
import { BallotSignatureTaskDetails } from "./components/BallotSignatureTaskDetails";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useNavigation, useRoute } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { CustomButton } from "../../components/CustomButton";

export default function SignatureTaskScreen() {
	const { task } = useRoute().params as { task: SignatureTask };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	const sign = () => {
		console.log("sign");
		navigation.goBack();
	};

	const reject = () => {
		console.log("reject");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				{task.signatureType === "administration" && (
					<AdministrationSignatureTaskDetails task={task as AdministrationSignatureTask} />
				)}
				{task.signatureType === "authority" && (
					<AuthoritySignatureTaskDetails task={task as AuthoritySignatureTask} />
				)}
				{task.signatureType === "network" && (
					<NetworkSignatureTaskDetails task={task as NetworkSignatureTask} />
				)}
				{task.signatureType === "election" && (
					<ElectionSignatureTaskDetails task={task as ElectionSignatureTask} />
				)}
				{task.signatureType === "election-revision" && (
					<ElectionRevisionSignatureTaskDetails task={task as ElectionRevisionSignatureTask} />
				)}
				{task.signatureType === "ballot" && (
					<BallotSignatureTaskDetails task={task as BallotSignatureTask} />
				)}
			</ScrollView>
			<View
				style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
			>
				<CustomButton
					title={t("sign")}
					icon="check"
					backgroundColor={colors.success}
					size="thin"
					flex={true}
					onPress={sign}
				/>
				<CustomButton
					title={t("reject")}
					icon="xmark"
					backgroundColor={colors.error}
					size="thin"
					flex={true}
					onPress={reject}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
