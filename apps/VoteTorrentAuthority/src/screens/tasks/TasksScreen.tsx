import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
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
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { InlineError } from "../../components/InlineError";
import { NoNetwork } from "../../components/NoNetwork";
import { PeerReadUnavailableNotice } from "../../components/PeerReadUnavailableNotice";
import { classifyPeerReadFailure } from "../../engines/peer-read-unavailable";
import { isNoNetworkEstablishedError } from "../../engines/engine-factory";
import { loadRenderableSignatureTasks, type RenderableSignatureTask } from "./renderable-signature-tasks";
import { useStrandChanges } from "../../hooks/useStrandChanges";

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
				// Defensive: authority may be absent if materialisation failed; fall back to network name.
				return (task as AdminSignatureTask).authority?.name ?? task.network.name;
			case "authority":
				return (task as AuthoritySignatureTask).authority?.proposed?.name ?? task.network.name;
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
	const [signatureTasks, setSignatureTasks] = useState<RenderableSignatureTask[]>();
	const [loadError, setLoadError] = useState("");
	const [peerUnavailable, setPeerUnavailable] = useState(false);
	// Distinct from loadError: "no network selected yet" is the expected first-run
	// state, so it renders the friendly <NoNetwork /> empty state rather than an
	// error banner carrying an internal EngineFactory message.
	const [hasNetwork, setHasNetwork] = useState(true);
	const navigation = useNavigation<NavigationProp>();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("allNetworks") });
	}, [navigation, t]);

	const loadTasksEngines = useCallback(async () => {
		setLoadError("");
		setPeerUnavailable(false);
		setHasNetwork(true);
		try {
			const [keyTasksEngine, signatureTasksEngine] = await Promise.all([
				getEngine<IKeysTasksEngine>("keysTasksEngine"),
				getEngine<ISignatureTasksEngine>("signatureTasksEngine"),
			]);

			const [keysToRelease, requestedSignatures] = await Promise.all([
				keyTasksEngine.getKeysToRelease(true),
				signatureTasksEngine.getRequestedSignatures(true),
			]);
			// 62-12 (Surface 5): loadRenderableSignatureTasks is the ONE shared filter —
			// see renderable-signature-tasks.ts for the full rationale (registrant exclusion,
			// D-11 unreachable exclusion). useTaskCount.ts calls the SAME function.
			const renderable = await loadRenderableSignatureTasks(signatureTasksEngine, requestedSignatures);
			setReleaseKeyTasks(keysToRelease);
			setSignatureTasks(renderable);
		} catch (error) {
			if (isNoNetworkEstablishedError(error)) {
				// Expected on first run / after leaving a network — not an error.
				setHasNetwork(false);
				return;
			}
			const peer = classifyPeerReadFailure(error);
			if (peer) {
				console.warn("Tasks load: peer unavailable:", peer.reason);
				setPeerUnavailable(true);
				return;
			}
			console.error("Error in loadTasksEngines:", error);
			setLoadError(t("tasksLoadFailed"));
		}
	}, [getEngine, t]);

	useFocusEffect(
		useCallback(() => {
			loadTasksEngines();
		}, [loadTasksEngines])
	);

	// A task another officer created or completed shows up while this list is on screen.
	useStrandChanges(["App.Task"], () => {
		loadTasksEngines();
	}, "authority-tasks");

	// Matches ElectionsScreen/AuthoritiesScreen: no network selected is an empty
	// state, not a failure. Checked before isEmpty so the friendly prompt wins
	// over "no tasks" (which would wrongly imply the network had been consulted).
	if (!hasNetwork) {
		return <NoNetwork />;
	}

	// 48-11 handoff / 62-12 (Surface 5, D-11): the pull-and-seed call above stays UNCHANGED —
	// it is idempotent and the registration approval ceremony needs it, so it must keep firing
	// from this consumer verbatim. The RENDERED population is filtered by
	// `loadRenderableSignatureTasks` in renderable-signature-tasks.ts — see that module for the
	// full rationale ('registrant' tasks never reach this screen; an `unreachable` session takes
	// the existing closed-task path, same as 'registrant'). `useTaskCount.ts` calls the SAME
	// function, so the list and the badge can never diverge.
	const renderableSignatureTasks = signatureTasks ?? [];

	const peerNotice = peerUnavailable ? (
		<PeerReadUnavailableNotice
			variant={releaseKeyTasks !== undefined || signatureTasks !== undefined ? "stale" : "unavailable"}
			onRetry={loadTasksEngines}
		/>
	) : null;

	// Nothing loaded and the other devices cannot be reached: say so, never "no tasks".
	if (peerUnavailable && releaseKeyTasks === undefined && signatureTasks === undefined) {
		return <ScrollView style={styles.container}>{peerNotice}</ScrollView>;
	}

	const isEmpty =
		releaseKeyTasks !== undefined &&
		signatureTasks !== undefined &&
		releaseKeyTasks.length === 0 &&
		renderableSignatureTasks.length === 0;

	if (isEmpty) {
		return (
			<View style={styles.emptyState}>
				<InlineError message={loadError} />
				{peerNotice}
				<FontAwesome6 name="clipboard-list" size={48} color={colors.textSecondary} />
				<ThemedText type="title">{t("noTasks")}</ThemedText>
				<ThemedText type="default">{t("noTasksHelper")}</ThemedText>
			</View>
		);
	}

	// Build an authority-keyed map preserving engine order. We walk
	// releaseKeyTasks first, then renderableSignatureTasks; within each
	// authority bucket we preserve the order tasks arrived from the engine
	// (D-04 — no sort). Each entry carries the task's co-signing status (null
	// for release-key tasks — TaskCard/ThresholdProgressNote render nothing for null).
	type GroupedEntry = { task: ReleaseKeyTask | SignatureTask; status: RenderableSignatureTask["status"] };
	const grouped = new Map<string, GroupedEntry[]>();
	const pushEntry = (entry: GroupedEntry) => {
		const key = getAuthorityGroupKey(entry.task);
		const bucket = grouped.get(key);
		if (bucket) {
			bucket.push(entry);
		} else {
			grouped.set(key, [entry]);
		}
	};
	(releaseKeyTasks ?? []).forEach((task) => pushEntry({ task, status: null }));
	renderableSignatureTasks.forEach((entry) => pushEntry({ task: entry.task, status: entry.status }));

	const renderChipForTask = (task: ReleaseKeyTask | SignatureTask) => {
		if (task.type === "release-key") {
			return { label: t("chipRelease"), color: colors.important };
		}
		// signature tasks
		return { label: t("chipSignature"), color: colors.accent };
	};

	return (
		<ScrollView style={styles.container}>
			<InlineError message={loadError} />
			{peerNotice}
			{Array.from(grouped.entries()).map(([authorityName, entries]) => (
				<View key={authorityName} style={styles.section}>
					<ThemedText type="title">{authorityName}</ThemedText>
					<View>
						{entries.map((entry, index) => {
							const { task } = entry;
							const chip = renderChipForTask(task);
							const onPress =
								task.type === "release-key"
									? () => navigation.navigate("KeyRelease", { task: task as ReleaseKeyTask })
									: () => navigation.navigate("SignatureTask", { task: task as SignatureTask });
							return (
								<TaskCard
									key={`${authorityName}-${index}`}
									task={task}
									onPress={onPress}
									chipLabel={chip.label}
									chipColor={chip.color}
									thresholdStatus={entry.status}
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
