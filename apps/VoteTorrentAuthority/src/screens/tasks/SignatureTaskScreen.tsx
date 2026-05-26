import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import type {
	SignatureTask,
	AdminSignatureTask,
	AuthoritySignatureTask,
	NetworkSignatureTask,
	ElectionSignatureTask,
	ElectionRevisionSignatureTask,
	BallotSignatureTask,
} from "@votetorrent/vote-core";
import { AdminSignatureTaskDetails } from "./components/AdminSignatureTaskDetails";
import { AuthoritySignatureTaskDetails } from "./components/AuthoritySignatureTaskDetails";
import { NetworkSignatureTaskDetails } from "./components/NetworkSignatureTaskDetails";
import { ElectionSignatureTaskDetails } from "./components/ElectionSignatureTaskDetails";
import { ElectionRevisionSignatureTaskDetails } from "./components/ElectionRevisionSignatureTaskDetails";
import { BallotSignatureTaskDetails } from "./components/BallotSignatureTaskDetails";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute } from "@react-navigation/native";

const titleKey: Record<SignatureTask["signatureType"], string> = {
	admin: "adminRevision",
	authority: "authorityRevision",
	network: "networkRevision",
	election: "election",
	"election-revision": "electionRevision",
	ballot: "ballotRevision",
};

export default function SignatureTaskScreen() {
	const { task } = useRoute().params as { task: SignatureTask };
	const { t } = useTranslation();
	const navigation = useNavigation();
	const isNetwork = task.signatureType === "network";

	useLayoutEffect(() => {
		navigation.setOptions({ title: t(titleKey[task.signatureType]) });
	}, [navigation, t, task.signatureType]);

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
				{task.signatureType === "admin" && (
					<AdminSignatureTaskDetails task={task as AdminSignatureTask} />
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
			<SignatureTaskFooter
				onAccept={sign}
				onReject={reject}
				acceptLabel={isNetwork ? t("accept") : t("sign")}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
