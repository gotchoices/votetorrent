import { useLayoutEffect, useState } from "react";
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
	ISignatureTasksEngine,
} from "@votetorrent/vote-core";
import { AdminSignatureTaskDetails } from "./components/AdminSignatureTaskDetails";
import { AuthoritySignatureTaskDetails } from "./components/AuthoritySignatureTaskDetails";
import { NetworkSignatureTaskDetails } from "./components/NetworkSignatureTaskDetails";
import { ElectionSignatureTaskDetails } from "./components/ElectionSignatureTaskDetails";
import { ElectionRevisionSignatureTaskDetails } from "./components/ElectionRevisionSignatureTaskDetails";
import { BallotSignatureTaskDetails } from "./components/BallotSignatureTaskDetails";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";

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
	const { getEngine } = useApp();
	const isNetwork = task.signatureType === "network";

	const [errorMessage, setErrorMessage] = useState<string>("");

	useLayoutEffect(() => {
		navigation.setOptions({ title: t(titleKey[task.signatureType]) });
	}, [navigation, t, task.signatureType]);

	// SIGN-02 accept path (D-01/D-03/D-04):
	//   1. Obtain engine-authoritative digest via getSignatureDigest (D-03 — screen never recomputes)
	//   2. Sign with device-signer callback (D-01 — private key stays app-side)
	//   3. Call completeSignature with the resulting Signature only
	const sign = async () => {
		setErrorMessage("");
		try {
			const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			const digest = await engine.getSignatureDigest(task);
			const signer = await createDeviceSigner("Device User");
			const signature = await signer(digest);
			await engine.completeSignature(task, { isAccepted: true, signature });
			navigation.goBack();
		} catch (err) {
			console.warn("sign error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
			return;
		}
	};

	// SIGN-02 reject path (D-12 — NO signing):
	//   On reject the screen MUST NOT invoke the device-signer or produce a real signature.
	//   The engine's if (result.isAccepted) branch (plan 21-06) skips signingEngine.sign()
	//   so no OfficerSignature is inserted and the signing session is not advanced (D-12).
	const reject = async () => {
		setErrorMessage("");
		try {
			const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			await engine.completeSignature(task, {
				isAccepted: false,
				signature: { signature: "", signerKey: "", signerUserId: "" },
			});
			navigation.goBack();
		} catch (err) {
			console.warn("reject error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
			return;
		}
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
			<InlineError message={errorMessage} />
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
