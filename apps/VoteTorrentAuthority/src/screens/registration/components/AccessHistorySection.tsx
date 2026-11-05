import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { errorCopy } from "../../../utils/errorCopy";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import { useApp } from "../../../providers/AppProvider";
import { formatAccessTimestamp, joinFieldNames, resolveViewerLabel } from "../access-history-format";
import type { IRegistrationEngine, INetworkEngine, RegistrantAccessEvent } from "@votetorrent/vote-core";

export interface AccessHistorySectionProps {
	/** Scopes the read — every trail row this section can ever show belongs to this registrant. */
	registrantId: string;
	/**
	 * 47-20's already-computed `'vrg'` derivation (`scopes?.includes("vrg") === true`).
	 * This component deliberately does NOT call `useCurrentOfficerScopes` itself, so the
	 * detail screen resolves the officer's scopes exactly once and this section cannot
	 * drift from the private tier's gate.
	 */
	canView: boolean;
}

/**
 * AccessHistorySection — the D-01 reviewer surface. D-01 accepted the
 * `RegistrantPrivate` access trail only on the explicit condition that it
 * ship with a way to READ it. This is the only place a human ever sees any
 * of it: a default-collapsed, `ChipButton`-toggled section that lazily
 * reads `IRegistrationEngine.getRegistrantAccessEvents` on first expand and
 * renders the revealed field NAMES (never values) with a viewer + UTC
 * timestamp line, newest first, exactly as the engine returned them.
 *
 * Default-collapsed is the one divergence from this screen's default-open
 * section posture: this is a review surface an officer consults
 * deliberately, not read-by-default context (`47-UI-SPEC.md:353-357`).
 */
export function AccessHistorySection({ registrantId, canView }: AccessHistorySectionProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();

	// Default-collapsed (D-01): mounting the registrant detail screen must not
	// pay for a trail query nobody asked for. Do not "fix" this to `true` to
	// match the default-open sections above it on this screen — that would
	// undo the deliberate divergence `47-UI-SPEC.md:353-357` calls for.
	const [isOpen, setIsOpen] = useState(false);
	const [events, setEvents] = useState<RegistrantAccessEvent[]>([]);
	const [viewerNames, setViewerNames] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");

	// Set to true only on a SUCCESSFUL load, so a failed read is retried the
	// next time the officer expands the section.
	const hasLoadedRef = useRef(false);

	// CR-02 guard against a stale setState after unmount, copied from
	// RegistrationPolicyScreen.tsx:102-111. Reset on entry so a cleanup that
	// runs while the component stays mounted (StrictMode double-invoke, Fast
	// Refresh, remount-in-place) does not permanently latch every setState off.
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const resolveViewerNames = useCallback(
		async (rows: RegistrantAccessEvent[]) => {
			// A name-resolution failure is never an error state — resolveViewerLabel
			// already falls back to a truncated id, and 47-UI-SPEC.md:350-352 requires
			// that resolution never block rendering a row. This is also why this catch
			// logs nothing to the console (AuthorizationSection.tsx:52 does; that is
			// the one thing not copied from it).
			try {
				const distinctIds = Array.from(new Set(rows.map((r) => r.viewerUserId)));
				const netEngine = await getEngine<INetworkEngine>("network");
				if (!netEngine) return;

				const resolved = await Promise.all(
					distinctIds.map(async (id) => {
						try {
							const userEngine = await netEngine.getUser(id);
							const user = await userEngine?.getSummary();
							return { id, name: user?.name };
						} catch {
							return { id, name: undefined };
						}
					}),
				);

				if (unmountedRef.current) return;
				const next: Record<string, string> = {};
				for (const { id, name } of resolved) {
					if (typeof name === "string" && name.trim().length > 0) next[id] = name;
				}
				setViewerNames((prev) => ({ ...prev, ...next }));
			} catch {
				// swallow — see comment above
			}
		},
		[getEngine],
	);

	const loadEvents = useCallback(async () => {
		setLoading(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			if (!engine) return;

			const rows = await engine.getRegistrantAccessEvents(registrantId);
			// Never sort, filter, slice, paginate or de-duplicate `rows`: 47-07
			// already returns newest-first and unbounded, and the surface is one
			// row per screen-visit.
			if (!unmountedRef.current) setEvents(rows);
			hasLoadedRef.current = true;

			// Non-blocking, best-effort name-resolution pass — never awaited before
			// setEvents, so rows render immediately with truncated-id labels and
			// upgrade in place.
			void resolveViewerNames(rows);
		} catch (err) {
			// The caught message is rendered as-is, but no field name, no viewer id
			// and no registrant id is interpolated into it, and nothing is logged to
			// the console (T-47-02). 47-07's rethrow produces
			// "RegistrationEngine.getRegistrantAccessEvents: …" and binds no row
			// value into it.
			if (!unmountedRef.current) {
				setErrorMessage(errorCopy(err, t, "read", { log: false }));
			}
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
	}, [getEngine, registrantId, resolveViewerNames]);

	const onToggle = useCallback(() => {
		const next = !isOpen;
		setIsOpen(next);
		// Lazy, on first expand only: the section is default-collapsed and
		// consulted deliberately, so mounting the registrant detail screen must
		// not pay for a query nobody asked for. Because D-14 flushes the
		// current visit's row on unmount, the trail written during this visit
		// could not appear in this visit's list anyway, so there is nothing to
		// refresh mid-visit.
		if (next && !hasLoadedRef.current && !loading) {
			void loadEvents();
		}
	}, [isOpen, loading, loadEvents]);

	// D-13 transitive gate: the rows are the NAMES of private attributes that
	// were revealed, so rendering them to an officer lacking 'vrg' would
	// disclose which private fields exist for this registrant — exactly what
	// 47-UI-SPEC.md:307-316's hide-entirely divergence exists to prevent for
	// the private tier itself. This is a deliberate, documented extension of
	// that divergence to this section, not an inconsistency to "fix" toward
	// Phase 46's visible-but-disabled default pattern. This is a UI
	// legibility posture, not an enforcement boundary (T-47-04): Quereus
	// tables are not read-gated and an officer holding the device can query
	// the local file directly regardless of this check.
	if (!canView) return null;

	const showLoading = loading && events.length === 0;
	const showEmpty = !loading && events.length === 0 && errorMessage === "";

	return (
		<View style={styles.section} testID="access-history-section">
			<View testID="access-history-toggle">
				{/* The manual RegistrationPolicyScreen.tsx:725-729 toggle idiom, not the
				    shared collapsible-section component: that component always
				    renders an unsuppressible search box on expand, and this section
				    needs none (Phase 46 made the identical call for the same reason). */}
				<ChipButton
					label={t("registrantAccessTrailSectionTitle")}
					icon={isOpen ? "chevron-down" : "chevron-right"}
					onPress={onToggle}
				/>
			</View>
			{isOpen && (
				<View testID="access-history-body">
					{/* Load-bearing copy (D-01) — the one place the officer is told, in
					    words, (a) what the trail records, (b) that it is for
					    accountability and transparency and explicitly not a security
					    control, and (c) that it captures app-mediated access only, so
					    direct database access is invisible to it. Renders exactly once,
					    in small/colors.textSecondary and never in colors.warning or
					    colors.error: this is neutral informational copy, not a flagged
					    issue (47-UI-SPEC.md:340-348). The string itself lives in
					    47-02's i18n map and is pinned character-for-character by
					    registrant-keys.test.ts — it is never reworded in this file. */}
					<ThemedText
						type="small"
						style={[localStyles.disclaimer, { color: colors.textSecondary }]}
						testID="access-history-disclaimer"
					>
						{t("registrantAccessTrailDisclaimer")}
					</ThemedText>

					<View testID="access-history-error">
						<InlineError message={errorMessage} />
					</View>

					{showLoading && (
						<View testID="access-history-loading">
							{/* Copy-gap: the registrantAccessTrail* group has no loading key
							    and 47-02's contract test pins that group at exactly 5 keys
							    and the phase at 117, so none may be added.
							    registrantListLoadingMore is reused, following 47-11's
							    identical, already-recorded decision on the roster's initial
							    load. A dedicated loading key is a follow-up for a later plan. */}
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("registrantListLoadingMore")}
							</ThemedText>
						</View>
					)}

					{showEmpty && (
						<View testID="access-history-empty">
							<ThemedText type="defaultSemiBold">{t("registrantAccessTrailEmptyHeading")}</ThemedText>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("registrantAccessTrailEmptyBody")}
							</ThemedText>
						</View>
					)}

					{events.map((event) => {
						const viewer = resolveViewerLabel(event.viewerUserId, viewerNames[event.viewerUserId]);
						const fields = joinFieldNames(event.fields);
						const timestamp = formatAccessTimestamp(event.timestamp);

						// Row composition reconciles two parts of the UI-SPEC that pull
						// in different directions: 47-UI-SPEC.md:338 supplies
						// registrantAccessTrailRow as one interpolated sentence, while
						// :350-352 requires a tiny timestamp and a tinyBold field-name
						// list — a single t() string cannot carry two type variants, and
						// no key may be added to split it. The resolution: the visual
						// row is this two-ThemedText composite (satisfying the
						// typography contract), and the full localised sentence is
						// emitted as the row's accessibilityLabel (satisfying the copy
						// contract and giving screen-reader users the complete
						// sentence). The " — " between viewer and timestamp is a
						// formatting separator over two data values, not copy — the
						// same reasoning 47-11 recorded for rendering raw district
						// strings as chip labels.
						return (
							<View
								key={event.sequence}
								testID={"access-history-row-" + event.sequence}
								style={[styles.cardSurface, localStyles.row, { backgroundColor: colors.card }]}
								accessibilityLabel={t("registrantAccessTrailRow", { viewer, fields, timestamp })}
							>
								<ThemedText type="tinyBold" testID={"access-history-row-fields-" + event.sequence}>
									{fields}
								</ThemedText>
								<ThemedText
									type="tiny"
									style={{ color: colors.textSecondary }}
									testID={"access-history-row-meta-" + event.sequence}
								>
									{viewer + " — " + timestamp}
								</ThemedText>
							</View>
						);
					})}
				</View>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		gap: 4,
	},
	disclaimer: {
		marginTop: 8,
		marginBottom: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
