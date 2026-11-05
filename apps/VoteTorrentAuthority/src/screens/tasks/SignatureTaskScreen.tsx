import { useEffect, useLayoutEffect, useState } from "react";
import { errorCopy } from "../../utils/errorCopy";
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
	SigningStatus,
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
import { ThresholdProgressNote } from "./components/ThresholdProgressNote";
import { loadTaskSigningStatus } from "./renderable-signature-tasks";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";

// 'registrant' is deliberately excluded from this map's key type — it can never reach this
// screen. TasksScreen.tsx's `renderableSignatureTasks` filter and useTaskCount.ts's
// `renderableSigs` filter both exclude `signatureType === "registrant"` (registrant decisions
// go through RegistrationRequestApprovalScreen instead), and the two filters change together
// or not at all. Narrowing here with Exclude<> makes that existing exclusion structurally
// honest rather than adding an entry that could never be looked up.
const titleKey: Record<Exclude<SignatureTask["signatureType"], "registrant">, string> = {
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
	const [isProcessing, setIsProcessing] = useState(false);
	const [thresholdStatus, setThresholdStatus] = useState<SigningStatus | null>(null);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// 62-12 (Surface 5, D-09/D-10/D-11): load the task's own co-signing status on mount, display
	// only. An `unreachable` session takes the EXISTING closed-task path — the same thing that
	// already happens after Accept/Reject navigates back, just triggered by the status read
	// instead of a completion call. No new pill, no new copy (the UI-SPEC's "no veto UI").
	useEffect(() => {
		let cancelled = false;
		(async () => {
			let engine: ISignatureTasksEngine | undefined;
			try {
				engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			} catch {
				// An engine-resolution failure leaves the status null (fail-open, no note).
			}
			const status = await loadTaskSigningStatus(engine, task);
			if (cancelled) return;
			if (status?.unreachable) {
				navigation.goBack();
				return;
			}
			setThresholdStatus(status);
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [task]);

	useLayoutEffect(() => {
		// Guarded, not cast: 'registrant' tasks never reach this screen (see the titleKey
		// comment above), but task.signatureType is still typed as the full union, so the
		// lookup needs this narrowing test to typecheck under strict mode.
		if (task.signatureType !== "registrant") {
			navigation.setOptions({ title: t(titleKey[task.signatureType]) });
		}
	}, [navigation, t, task.signatureType]);

	// SIGN-02 accept path (D-01/D-03/D-04):
	//   1. Obtain engine-authoritative digest via getSignatureDigest (D-03 — screen never recomputes)
	//   2. Sign with device-signer callback (D-01 — private key stays app-side)
	//   3. Call completeSignature with the resulting Signature only
	const sign = async () => {
		setErrorMessage("");
		setIsProcessing(true);
		try {
			const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			const digest = await engine.getSignatureDigest(task);
			const signer = await createDeviceSigner("Device User");
			const signature = await signer(digest);
			// 39-03 (DEBT-11, D-06): `signer` is a plain in-memory closure over the
			// already-unlocked device private key (device-signer.ts) — re-invocable
			// with no additional user decision — so it doubles as the reusable
			// per-digest `sign` callback finalizeBallot uses to REAL-sign each
			// promoted per-row Question/Option AdminSigning digest. Only `ballot`
			// signature tasks drive finalizeBallot (IN-02, 39-REVIEW).
			// 57-08 (Trigger B): `admin` tasks are the second consumer — a co-signer
			// accepting a pending "Revise Administration" task may complete the 'rad'
			// threshold, and completeSignature's promotion attempt (applyAdminProposal)
			// mints two or three distinct digests, so it likewise needs this
			// re-invocable closure rather than the single pre-computed `signature`
			// above. `sign` stays a no-op for every OTHER signatureType.
			await engine.completeSignature(task, {
				isAccepted: true,
				signature,
				sign: task.signatureType === "ballot" || task.signatureType === "admin" ? signer : undefined,
			});
			navigation.goBack();
		} catch (err) {
			console.warn("sign error:", err);
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? errorCopy(err, t, "write"));
			return;
		} finally {
			setIsProcessing(false);
		}
	};

	// SIGN-02 reject path (D-12 — NO signing):
	//   On reject the screen MUST NOT invoke the device-signer or produce a real signature.
	//   The engine's if (result.isAccepted) branch (plan 21-06) skips signingEngine.sign()
	//   so no OfficerSignature is inserted and the signing session is not advanced (D-12).
	// 62-12 (D-11): above threshold 1 this completion is a RECORDED VOTE, not a veto — no confirm
	// dialog, no second engine call, nothing else. The session is only ever shown as failed once
	// `getSigningStatus` derives it `unreachable` (the mount effect above), never from this call
	// itself.
	const reject = async () => {
		setErrorMessage("");
		setIsProcessing(true);
		try {
			const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			await engine.completeSignature(task, {
				isAccepted: false,
				signature: { signature: "", signerKey: "", signerUserId: "" },
			});
			navigation.goBack();
		} catch (err) {
			console.warn("reject error:", err);
			// This path never calls createDeviceSigner (D-12), so
			// isDeviceSigningError will always classify a rejection here as
			// "not mine" — routed through the same shared handler anyway for
			// consistency with every other migrated catch block.
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? errorCopy(err, t, "write"));
			return;
		} finally {
			setIsProcessing(false);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<ThresholdProgressNote status={thresholdStatus} testID="signature-task-threshold-note" />
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
				acceptLabel={
					isProcessing
						? `${isNetwork ? t("accept") : t("sign")}…`
						: isNetwork
							? t("accept")
							: t("sign")
				}
				disabled={isProcessing}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
