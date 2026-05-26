import React, { useEffect, useLayoutEffect, useState } from "react";
import { View, StyleSheet, ScrollView } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { useApp } from "../../providers/AppProvider";
import {
	IKeysTasksEngine,
	ISignatureTasksEngine,
	ReleaseKeyTask,
	SignatureTask,
	AdminSignatureTask,
	AuthoritySignatureTask,
} from "@votetorrent/vote-core";
import TaskCard from "./components/TaskCard";
import type { NavigationProp } from "../../navigation/types";
import { useNavigation } from "@react-navigation/native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";

// Resolve the authority grouping key for a task. Falls back to the network
// name when an authority-specific name is not accessible on the task type
// (e.g. release-key tasks expose only authorityId via ElectionCore).
function getAuthorityGroupKey(task: ReleaseKeyTask | SignatureTask): string {
	if (task.type === "release-key") {
		return task.network.name;
	}
	if (task.type === "signature") {
		switch (task.signatureType) {
			case "admin":
				return (task as AdminSignatureTask).authority.name;
			case "authority":
				return (task as AuthoritySignatureTask).authority.proposed.name;
			case "network":
			case "election":
			case "election-revision":
			case "ballot":
			default:
				return task.network.name;
		}
	}
	return "";
}

export default function TasksScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [releaseKeyTasks, setReleaseKeyTasks] = useState<ReleaseKeyTask[]>();
	const [signatureTasks, setSignatureTasks] = useState<SignatureTask[]>();
	const navigation = useNavigation<NavigationProp>();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("allNetworks") });
	}, [navigation, t]);

	useEffect(() => {
		async function loadTasksEngines() {
			try {
				const [keyTasksEngine, signatureTasksEngine] = await Promise.all([
					getEngine<IKeysTasksEngine>("keysTasksEngine"),
					getEngine<ISignatureTasksEngine>("signatureTasksEngine"),
				]);

				const [keysToRelease, requestedSignatures] = await Promise.all([
					keyTasksEngine.getKeysToRelease(true),
					signatureTasksEngine.getRequestedSignatures(true),
				]);
				setReleaseKeyTasks(keysToRelease);
				setSignatureTasks(requestedSignatures);
			} catch (error) {
				console.error("Error in loadTasksEngines:", error);
			}
		}
		loadTasksEngines();
	}, [getEngine]);

	const isEmpty =
		releaseKeyTasks !== undefined &&
		signatureTasks !== undefined &&
		releaseKeyTasks.length === 0 &&
		signatureTasks.length === 0;

	if (isEmpty) {
		return (
			<View style={styles.emptyState}>
				<FontAwesome6 name="clipboard-list" size={48} color={colors.textSecondary} />
				<ThemedText type="title">{t("noTasks")}</ThemedText>
				<ThemedText type="default">{t("noTasksHelper")}</ThemedText>
			</View>
		);
	}

	// Build an authority-keyed map preserving engine order. We walk
	// releaseKeyTasks first, then signatureTasks; within each authority bucket
	// we preserve the order tasks arrived from the engine (D-04 — no sort).
	const grouped = new Map<string, Array<ReleaseKeyTask | SignatureTask>>();
	const pushTask = (task: ReleaseKeyTask | SignatureTask) => {
		const key = getAuthorityGroupKey(task);
		const bucket = grouped.get(key);
		if (bucket) {
			bucket.push(task);
		} else {
			grouped.set(key, [task]);
		}
	};
	(releaseKeyTasks ?? []).forEach(pushTask);
	(signatureTasks ?? []).forEach(pushTask);

	const renderChipForTask = (task: ReleaseKeyTask | SignatureTask) => {
		if (task.type === "release-key") {
			return { label: t("chipRelease"), color: colors.important };
		}
		// signature tasks
		return { label: t("chipSignature"), color: colors.accent };
	};

	return (
		<ScrollView style={styles.container}>
			{Array.from(grouped.entries()).map(([authorityName, tasks]) => (
				<View key={authorityName} style={styles.section}>
					<ThemedText type="title">{authorityName}</ThemedText>
					<View>
						{tasks.map((task, index) => {
							const chip = renderChipForTask(task);
							const onPress =
								task.type === "release-key"
									? () => navigation.navigate("KeyTask", { task: task as ReleaseKeyTask })
									: () => navigation.navigate("SignatureTask", { task: task as SignatureTask });
							return (
								<TaskCard
									key={`${authorityName}-${index}`}
									task={task}
									onPress={onPress}
									chipLabel={chip.label}
									chipColor={chip.color}
								/>
							);
						})}
					</View>
				</View>
			))}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	emptyState: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingTop: 48,
	},
});

const styles = { ...globalStyles, ...localStyles };

export { TasksScreen };
