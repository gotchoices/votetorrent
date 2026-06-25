import { useCallback, useEffect, useState } from "react";
import type { IKeysTasksEngine, ISignatureTasksEngine } from "@votetorrent/vote-core";
import { useFocusEffect } from "@react-navigation/native";
import { useApp } from "../providers/AppProvider";

/**
 * Return the total count of pending tasks (keys to release + requested signatures)
 * using the same engine queries as TasksScreen so the badge and the list share one
 * data source and can never diverge.
 *
 * Re-queries on screen focus so the badge stays in sync after task mutations
 * (stale-task fix D-06).
 *
 * Returns 0 while loading or when the network is not yet established.
 */
export function useTaskCount(): number {
	const { getEngine } = useApp();
	const [count, setCount] = useState<number>(0);

	const fetchCount = useCallback(async () => {
		let cancelled = false;
		try {
			const [keyTasksEngine, signatureTasksEngine] = await Promise.all([
				getEngine<IKeysTasksEngine>("keysTasksEngine"),
				getEngine<ISignatureTasksEngine>("signatureTasksEngine"),
			]);

			const [keys, sigs] = await Promise.all([
				keyTasksEngine.getKeysToRelease(true),
				signatureTasksEngine.getRequestedSignatures(true),
			]);

			if (!cancelled) {
				setCount(keys.length + sigs.length);
			}
		} catch {
			// Network may not be established yet at first render — leave count at 0
			// to match the Tasks list empty-state behaviour.
		}
		return () => { cancelled = true; };
	}, [getEngine]);

	// Initial load on mount
	useEffect(() => {
		fetchCount();
	}, [fetchCount]);

	// Re-query on screen focus so the badge stays in sync after task mutations.
	useFocusEffect(
		useCallback(() => {
			fetchCount();
		}, [fetchCount])
	);

	return count;
}
