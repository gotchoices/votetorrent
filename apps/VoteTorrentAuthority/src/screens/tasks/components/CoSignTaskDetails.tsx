import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AssociationSignatureTask, IntakePolicySignatureTask } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";

/** Shortens a long id or key for display: the first and last 8 characters. */
function shortId(value: string): string {
	return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

/** A proposed change to the authority's registration settings, awaiting this officer's signature. */
export function IntakePolicySignatureTaskDetails({ task }: { task: IntakePolicySignatureTask }) {
	const { t } = useTranslation();
	const { proposal } = task;
	return (
		<View style={styles.cardSurface} testID="intake-policy-task-details">
			<ThemedText type="default">{t("intakePolicyTaskBody")}</ThemedText>
			<View style={localStyles.row}>
				<ThemedText type="small">{t("intakePolicyTaskBridgeLabel")}</ThemedText>
				<ThemedText type="default" testID="intake-policy-task-bridge">
					{proposal.restBridgeUrl ?? t("intakePolicyTaskNoBridge")}
				</ThemedText>
			</View>
			<View style={localStyles.row}>
				<ThemedText type="small">{t("registrationPolicyReassociationHeading")}</ThemedText>
				<ThemedText type="default" testID="intake-policy-task-mode">
					{t(proposal.reassociationMode === "automatic" ? "registrationPolicyReassociationAutomatic" : "registrationPolicyReassociationManual")}
				</ThemedText>
			</View>
		</View>
	);
}

/** Another officer's decision on a device change request, awaiting this officer's signature. */
export function AssociationSignatureTaskDetails({ task }: { task: AssociationSignatureTask }) {
	const { t } = useTranslation();
	return (
		<View style={styles.cardSurface} testID="association-task-details">
			<ThemedText type="default" testID="association-task-decision">
				{task.decision === "a"
					? t("associationTaskApproveBody", { registrant: shortId(task.registrantId ?? "") })
					: t("associationTaskRejectBody")}
			</ThemedText>
			<View style={localStyles.row}>
				<ThemedText type="small">{t("associationTaskDeviceLabel")}</ThemedText>
				<ThemedText type="default">{shortId(task.deviceKey)}</ThemedText>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
