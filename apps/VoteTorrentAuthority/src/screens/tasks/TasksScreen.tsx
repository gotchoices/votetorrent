import React, { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView, Task } from "react-native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { useApp } from "../../providers/AppProvider";
import {
	IKeysTasksEngine,
	IOnboardingTasksEngine,
	ISignatureTasksEngine,
	ReleaseKeyTask,
	SignatureTask,
} from "@votetorrent/vote-core";
import TaskCard from "./components/TaskCard";
import type { NavigationProp } from "../../navigation/types";
import { useNavigation } from "@react-navigation/native";

export default function TasksScreen() {
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const [releaseKeyTasks, setReleaseKeyTasks] = useState<ReleaseKeyTask[]>();
	const [signatureTasks, setSignatureTasks] = useState<SignatureTask[]>();
	const [onboardingTasks, setOnboardingTasks] = useState<string[]>();
	const [keyHistory, setKeyHistory] = useState<ReleaseKeyTask[]>();
	const [signatureHistory, setSignatureHistory] = useState<SignatureTask[]>();
	const navigation = useNavigation<NavigationProp>();

	useEffect(() => {
		async function loadTasksEngines() {
			console.log("loadTasksEngines called");
			try {
				const [keyTasksEngine, signatureTasksEngine, onboardingTasksEngine] = await Promise.all([
					getEngine<IKeysTasksEngine>("keysTasksEngine"),
					getEngine<ISignatureTasksEngine>("signatureTasksEngine"),
					getEngine<IOnboardingTasksEngine>("onboardingTasksEngine"),
				]);

				const [
					keysToRelease,
					requestedSignatures,
					completedOnboardingTasks,
					keyHistory,
					signatureHistory,
				] = await Promise.all([
					keyTasksEngine.getKeysToRelease(true),
					signatureTasksEngine.getRequestedSignatures(true),
					onboardingTasksEngine.getCompletedOnboardingTasks(),
					keyTasksEngine.getKeysToRelease(false),
					signatureTasksEngine.getRequestedSignatures(false),
				]);
				console.log("Data fetched:", {
					keysToRelease,
					requestedSignatures,
					completedOnboardingTasks,
					keyHistory,
					signatureHistory,
				});
				console.log("keyToRelease", keysToRelease);
				setReleaseKeyTasks(keysToRelease);
				setSignatureTasks(requestedSignatures);
				setOnboardingTasks(completedOnboardingTasks);
				setKeyHistory(keyHistory);
				setSignatureHistory(signatureHistory);
				console.log("State updated");
			} catch (error) {
				console.error("Error in loadTasksEngines:", error);
			}
		}
		loadTasksEngines();
	}, [getEngine]);

	return (
		<ScrollView style={styles.container}>
			{onboardingTasks && onboardingTasks.length > 0 && (
				<View style={styles.section}>
					<ThemedText type="title">{t("onboardingTasks")}</ThemedText>
				</View>
			)}
			{releaseKeyTasks && releaseKeyTasks.length > 0 && (
				<View style={styles.section}>
					<ThemedText type="title">{t("keysToRelease")}</ThemedText>
					<View>
						{releaseKeyTasks.map((task) => (
							<TaskCard
								key={task.election.election.title}
								task={task}
								onPress={() => {
									navigation.navigate("KeyTask", { task });
								}}
							/>
						))}
					</View>
				</View>
			)}
			{signatureTasks && signatureTasks.length > 0 && (
				<View style={styles.section}>
					<ThemedText type="title">{t("requestedSignatures")}</ThemedText>
					<View>
						{signatureTasks.map((task, index) => (
							<TaskCard
								key={index}
								task={task}
								onPress={() => {
									navigation.navigate("SignatureTask", { task });
								}}
							/>
						))}
					</View>
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };

export { TasksScreen };
