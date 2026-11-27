import React, { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useFocusEffect,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { errorCopy } from "../../utils/errorCopy";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { scopeLabel } from "../../utils/scopeLabel";
import type {
	IRegistrationEngine,
	ISignatureTasksEngine,
	RegistrationRequestIssuerType,
	RegistrationRequestListFilter,
	RegistrationRequestListRow,
	RegistrationRequestStatus,
	RegistrationTransparencyStats,
} from "@votetorrent/vote-core";
import { RegistrationRequestRow } from "./components/RegistrationRequestRow";
import { ReassociationQueueSection } from "./components/ReassociationQueueSection";
import { ReassociationReviewToggle } from "../elections/components/ReassociationReviewToggle";
import { registrationContentUnreadKey } from "./continuity-review";
import { TransparencyStatsCard } from "./components/TransparencyStatsCard";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { useStrandChanges } from "../../hooks/useStrandChanges";
import { useWaitingActionCount } from "../../hooks/useCommitShare";

// D-12: this screen previously carried a screen-local loosely-typed
// navigation widening because RootStackParamList did not yet carry
// `RegistrationRequestApproval` or `BulkImportSync`. 48-21 added all three
// Phase 48 routes (navigation/types.ts) and registered their Stack.Screens
// (navigation/index.tsx), so this screen now navigates through
// `NativeStackNavigationProp<RootStackParamList>`, which checks both the
// route name AND the param shape — restoring the checking the widening had
// disabled. A widening left in place after its routes land compiles, works,
// and silently disables route-name checking on that call forever.

// UI-SPEC's 25-50 recommendation. This app has no virtualized-list-component
// precedent anywhere — every list in this codebase is a `.map()`-in-`ScrollView`
// — so pages are bounded here instead, keeping a bounded render regardless of
// queue depth.
const REGISTRATION_REQUESTS_PAGE_SIZE = 25;

/**
 * RegistrationInboxScreen — the D-03/D-09 triage surface an officer reaches
 * from Authority Details. Composes, in order: `InlineError` -> the
 * `'vrg'` scope-gate banner (a legibility affordance ONLY, never a security
 * boundary — the schema's `AdminSignature` CHECKs are hardcoded stubs,
 * Phase 999.1) -> `TransparencyStatsCard` (D-09, authority-wide, filter-
 * independent) -> search + filter chip bar -> the count line + sort label ->
 * `.map()`-in-`ScrollView` rows -> Load More / Loading more… / End of list.
 */
export default function RegistrationInboxScreen() {
	const { t } = useTranslation();
	const keyboardInset = useKeyboardInset();
	const { colors } = useTheme() as ExtendedTheme;
	// Decisions made on this phone (approval screens track them as "decision:<requestId>") that no
	// other member holds yet (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort).
	const unsharedDecisions = useWaitingActionCount("decision:");
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { authorityId } = useRoute().params as { authorityId: string };

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("vrg") === true;
	// `canWrite` gates ONLY this one boolean, computed once outside the JSX,
	// so `canWrite` itself never appears in a conditional-render position
	// anywhere below (rows, the stats card, the filter bar, the search
	// input, the header chip are all unconditional on it). See the
	// negative-space note above the header effect.
	const showReadOnlyBanner = !scopesLoading && !canWrite;

	useLayoutEffect(() => {
		// Avoids first-frame flicker (NetworksScreen.tsx:99-110's pattern):
		// setOptions runs in useLayoutEffect, before the first paint, so the
		// header never briefly renders without its title.
		//
		// Title ONLY, deliberately no header-right action (48-27, closing
		// 48-UAT.md gap 4): the native-stack header cannot fit a title beside
		// an action button whose width is locale-dependent — in Spanish,
		// "IMPORTACIÓN MASIVA / SINCRONIZAR" consumed the header entirely and
		// NO title rendered at all, leaving an officer who arrived by a deep
		// link or a back-stack unable to confirm which surface they were on.
		// The Bulk Import / Sync control now lives in the screen body instead
		// (see `registration-inbox-bulk-import-sync` below). Anyone re-adding
		// a header-side action here re-opens that defect.
		navigation.setOptions({
			title: t("registrationRequestScreenTitle"),
		});
		// Negative space (load-bearing, do not "complete" this):
		// - This screen has NO write control. Opening a request is a read;
		//   navigating to Bulk Import / Sync is a read. 48-20 owns the disabled
		//   treatment of its own Sync buttons; 48-19 owns Approve/Reject.
		//   `ChipButton` has NO `disabled` prop and must not be given one here
		//   — that would be a shared-component change belonging to no plan in
		//   this phase. The body control below is therefore NOT scope-disabled.
		// - Nothing on this screen is hidden or removed by `canWrite`. The
		//   variable exists solely to decide whether the read-only banner
		//   renders below. It must never gate rows, the stats card, the filter
		//   bar, the search input, or the body Bulk Import / Sync control. The
		//   ungated officer sees the entire inbox — only the destination
		//   screens' actions are inert.
	}, [navigation, t, authorityId]);

	// Filter state — primitives only, so buildFilter's dep array is stable
	// and comparable by value, not by reference.
	//
	// statusFilter initialises to "p" — the single most consequential
	// deviation from the roster analog (RegistrantsListScreen.tsx). This is a
	// TRIAGE inbox, not a directory: Pending is the mount default, and "All"
	// is an explicit officer action. Because the default is a real filter
	// value, the mount-default empty state is the FILTERED one — see
	// hasActiveFilters below.
	const [statusFilter, setStatusFilter] = useState<RegistrationRequestStatus | undefined>("p");
	const [issuerFilter, setIssuerFilter] = useState<RegistrationRequestIssuerType | undefined>(undefined);
	const [appliedName, setAppliedName] = useState<string | undefined>(undefined); // the SUBMITTED search term
	const [searchText, setSearchText] = useState<string>(""); // the live input buffer — deliberately NOT a filter input

	// Result state.
	const [rows, setRows] = useState<RegistrationRequestListRow[]>([]);
	const [total, setTotal] = useState<number | undefined>(undefined);
	const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
	const [loadingInitial, setLoadingInitial] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [stats, setStats] = useState<RegistrationTransparencyStats | undefined>(undefined);

	// CR-02/WR-08 guard against a stale setState: reset on entry so a cleanup
	// that runs while the component stays mounted (StrictMode double-invoke,
	// Fast Refresh, remount-in-place) does not permanently latch every
	// setState in loadFirstPage/loadMore off (RegistrantsListScreen.tsx:139-149).
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const buildFilter = useCallback((): RegistrationRequestListFilter => {
		// authorityId is ALWAYS supplied — an omitted authorityId is a
		// whole-database read the screen must never trigger.
		const filter: RegistrationRequestListFilter = { authorityId };
		if (statusFilter !== undefined) filter.status = statusFilter;
		if (issuerFilter !== undefined) filter.issuerType = issuerFilter;
		if (appliedName !== undefined) filter.name = appliedName;
		return filter;
	}, [authorityId, statusFilter, issuerFilter, appliedName]);

	const loadFirstPage = useCallback(async () => {
		setLoadingInitial(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			// Cursor deliberately ABSENT — that is precisely what makes 48-08 run
			// the count query, once per filter change (this callback's identity
			// only changes when a filter primitive changes — buildFilter's own
			// dep array).
			const result = await engine.listRegistrationRequests(buildFilter(), {
				pageSize: REGISTRATION_REQUESTS_PAGE_SIZE,
			});
			if (unmountedRef.current) return;
			setRows(result.rows);
			setNextCursor(result.nextCursor);
			// `result.total` being undefined here means the count query failed
			// (48-08 swallows it and returns the rows anyway) — store the
			// undefined and render registrationRequestCountUnknown. Never treat
			// it as an error, never set errorMessage, never skip rendering rows.
			setTotal(result.total);
		} catch (err) {
			// The caught error's message is rendered as-is; the filter object,
			// the officer's typed search term, and any row value are NEVER
			// interpolated into it and never passed to any logging call.
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read", { log: false }));
		} finally {
			if (!unmountedRef.current) setLoadingInitial(false);
		}
	}, [getEngine, buildFilter]);

	// useFocusEffect, NOT a plain useEffect (48-25, gap-2 fix). The premise a
	// plain effect relied on — "nothing else in the app mutates this queue
	// mid-session" — is FALSE: Bulk Import / Sync is reached from this
	// screen's own header, and the approval/rejection ceremonies are pushed
	// screens that pop back to this still-mounted inbox. A plain useEffect
	// only re-runs when loadFirstPage's identity changes (a filter
	// primitive), so a return from any of those three paths left the list
	// showing pre-decision data even though the write had committed — an
	// officer was shown a decision they just made as though it had not been
	// made. useCallback-wrapping is mandatory here, not stylistic:
	// useFocusEffect re-runs whenever the callback identity changes WHILE
	// focused, so an inline arrow would re-run on every render and loop; the
	// wrapper makes this exactly the union of "refetch on focus" and
	// "refetch on a filter change while focused" (loadFirstPage's identity
	// still tracks buildFilter's filter primitives). Accepted tradeoff: this
	// re-runs 48-08's count query on every focus, not only on a filter
	// change. That cost is accepted because pages are bounded at
	// REGISTRATION_REQUESTS_PAGE_SIZE and the alternative is the stale-queue
	// defect above.
	useFocusEffect(
		useCallback(() => {
			loadFirstPage();
		}, [loadFirstPage])
	);

	// A request that arrives (or another officer's decision) while the inbox is on screen re-reads the first page.
	useStrandChanges(["App.RegistrationRequest", "App.RegistrationDecision"], () => {
		loadFirstPage();
	}, "authority-registration-inbox");

	const loadStats = useCallback(async () => {
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			const result = await engine.getRegistrationTransparencyStats(authorityId);
			if (!unmountedRef.current) setStats(result);
		} catch {
			// A stats failure must NOT set errorMessage and must not block the
			// list: leave `stats` as `undefined` and let TransparencyStatsCard
			// render its own zero/unknown branches. Displacing a real list-load
			// error with a stats error would cost the officer the message that
			// actually matters. Swallowed silently in the same deliberate way
			// 48-08 swallows a failed count — never console.*'d.
		}
	}, [getEngine, authorityId]);

	// useFocusEffect, NOT a plain useEffect (48-25). The trigger is FOCUS,
	// not filter — the dep array below still excludes every filter primitive
	// ON PURPOSE (D-09), and that decision survives this conversion
	// unchanged. These counts are authority-wide. Recomputing them per
	// filter change would make them appear to respond to the chips, and
	// "Pending: 0" beside a Rejected-filtered list would read as a
	// contradiction rather than as two independent facts. Anyone who later
	// adds a filter primitive (statusFilter / issuerFilter / appliedName) to
	// loadStats's own dep array is deleting D-09 and must say so out loud in
	// the commit and here.
	useFocusEffect(
		useCallback(() => {
			loadStats();
		}, [loadStats])
	);

	// useFocusEffect, NOT mount-only (48-25). Best-effort, non-blocking
	// seeding of registrant signature tasks. 48-11 made
	// getRequestedSignatures(true) an IDEMPOTENT pull-and-seed — it creates
	// the Task + RegistrantSignatureTaskExtension + unsigned 'vrg'
	// AdminSigning rows the approval ceremony needs, and a second call
	// creates no duplicates. Firing it on every focus (not only on mount)
	// closes a second-order version of the gap-2 defect: a request imported
	// during the session via Bulk Import / Sync would now correctly APPEAR
	// in the refreshed list (see the list effect above) but have no seeded
	// signature task, so opening it could not produce a digest. Every
	// existing property is preserved: best-effort, non-blocking, never sets
	// errorMessage, never blanks the rows, never console.*'d.
	useFocusEffect(
		useCallback(() => {
			(async () => {
				try {
					const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
					await engine.getRequestedSignatures(true);
				} catch {
					// Best-effort — swallow silently, never console.*'d.
				}
			})();
		}, [getEngine])
	);

	async function loadMore() {
		if (loadingMore || nextCursor === undefined) return;
		setLoadingMore(true);
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			const result = await engine.listRegistrationRequests(buildFilter(), {
				cursor: nextCursor,
				pageSize: REGISTRATION_REQUESTS_PAGE_SIZE,
			});
			if (unmountedRef.current) return;
			// 48-08 handoff: an unresolvable cursor returns an EMPTY PAGE, never
			// page 1 — so an empty result.rows here is a normal terminal state
			// and must not be rendered as an error.
			setRows((prev) => [...prev, ...result.rows]);
			setNextCursor(result.nextCursor);
			// Deliberately NOT touching `total` here: a cursored call always
			// returns `total: undefined` (48-08's contract), so assigning it
			// would blank a perfectly good count on the second page.
		} catch (err) {
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read", { log: false }));
		} finally {
			if (!unmountedRef.current) setLoadingMore(false);
		}
	}

	function onSubmitSearch() {
		// Applied on submit, never per keystroke, with no setTimeout debounce:
		// a per-keystroke filter change re-runs the cached count(*) on every
		// character, and a timer is non-deterministic under
		// react-test-renderer, which this phase's D-12 bar requires every UI
		// decision to be assertable in.
		const q = searchText.trim();
		setAppliedName(q.length > 0 ? q : undefined);
	}

	// Because Status defaults to "p", this is `true` on mount, so the
	// mount-default empty state is the FILTERED one — an empty pending queue
	// renders registrationRequestEmptyHeading / …EmptyBody ("No requests
	// match these filters" / "Try a different status or source"), which is
	// both accurate and actionable. The …NoFilters pair renders only after
	// the officer has explicitly cleared to Status=All + Issuer=All + no
	// search. Rendering "No registration requests yet" over a merely-empty
	// pending queue would be a lie whenever approved or rejected requests
	// exist.
	const hasActiveFilters =
		statusFilter !== undefined || issuerFilter !== undefined || appliedName !== undefined;

	return (
		<ScrollView
			keyboardShouldPersistTaps="handled"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 + keyboardInset }}
		>
			<View style={styles.section} testID="registration-inbox-error">
				<InlineError message={errorMessage} />
			</View>

			{unsharedDecisions > 0 ? (
				<View style={styles.section}>
					<View testID="registration-inbox-decisions-not-shared" style={localStyles.banner} accessibilityLiveRegion="polite">
						<FontAwesome6 name="cloud-arrow-up" size={14} color={colors.warning} />
						<ThemedText type="small" style={{ color: colors.warningText ?? colors.text, flexShrink: 1 }}>
							{t("decisionsNotShared", { count: unsharedDecisions })}
						</ThemedText>
					</View>
				</View>
			) : null}

			{/* Two-branch scope-gate banner — a UI legibility affordance ONLY,
			    NEVER a security boundary (AdminSigning.SignerKeyValid /
			    OfficerSignature.OfficerValid are hardcoded stub CHECKs, Phase
			    999.1). Callers must NOT collapse the two branches: "you are not
			    an officer here" (scopes === undefined) and "you are an officer
			    but lack this permission" (a real, 'vrg'-less scope array) are
			    different facts with different remedies, and one message
			    covering both tells the second officer to go ask for a role they
			    already have. */}
			{showReadOnlyBanner &&
				(scopes === undefined ? (
					<View testID="registration-inbox-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="registration-inbox-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyBanner", { scope: scopeLabel("vrg", t) })}
						</ThemedText>
					</View>
				))}

			{/* D-09: always rendered, in every scope state and during loading —
			    the card is non-collapsible, and removing it while stats load
			    would shift the whole screen. Authority-wide and deliberately
			    does NOT respond to the filter chips below. */}
			<View style={styles.section} testID="registration-inbox-stats">
				<TransparencyStatsCard stats={stats} />
			</View>

			{/* Body-mounted Bulk Import / Sync control (48-27, closing 48-UAT.md
			    gap 4 — moved out of the header, see the setOptions comment
			    above). Position is deliberate and must not drift: below the
			    D-09 transparency card so the card keeps its topmost, filter-
			    independent prominence exactly as 48-18 established, and above
			    the filters so the control is still on the first screenful at
			    mount. A future "move it somewhere tidier" edit would cost D-09
			    its position — don't. Unconditional on `canWrite`/scope, exactly
			    as the header chip was (see the negative-space note above). */}
			<View style={styles.section} testID="registration-inbox-bulk-import-sync">
				<ChipButton
					label={t("registrationRequestBulkImportSyncButton")}
					onPress={() => navigation.navigate("BulkImportSync", { authorityId })}
				/>
			</View>

			{/* Phase 51 plan 51-10 (D-06/D-19) — the concrete tap sequence into
			    AssociationRequestStatusScreen, the read-only association-request
			    status screen: Registration Requests (this screen) -> this chip ->
			    AssociationRequestStatus. Placed beside
			    the Bulk Import / Sync chip above (both authority-wide, both reached
			    from here) rather than adding a new menu location. Unconditional on
			    canWrite/scope, matching the Bulk Import / Sync chip's own posture:
			    this screen is read-only regardless of scope. */}
			<View style={styles.section} testID="registration-inbox-association-request-status">
				<ChipButton
					label={t("associationRequestStatusInboxButton")}
					onPress={() => navigation.navigate("AssociationRequestStatus", { authorityId })}
				/>
			</View>

			{/* D-46: the per-authority device-change review setting, beside the queue it governs.
			    Moved here from the election's Registration Policy screen by the user ruling of
			    2026-10-07; same component, same 'vrg' scope (canWrite), same signed write. */}
			<View style={styles.section} testID="registration-inbox-reassociation-review">
				<ReassociationReviewToggle authorityId={authorityId} canWrite={canWrite} />
				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t("reassociationReviewAuthorityWide")}
				</ThemedText>
			</View>

			{/* D-41/D-46 (62-27): device-change requests awaiting officer review are reached from
			    here, and AssociationRequestStatusScreen stays control-free (Phase 51). The section
			    renders nothing without a peer network or with an empty queue. */}
			<View style={styles.section} testID="registration-inbox-reassociation-queue">
				<ReassociationQueueSection authorityId={authorityId} />
			</View>

			<View style={styles.section} testID="registration-inbox-filters">
				<View testID="registration-inbox-search">
					<CustomTextInput
						placeholder={t("registrationRequestSearchPlaceholder")}
						value={searchText}
						onChangeText={setSearchText}
						onSubmitEditing={onSubmitSearch}
						returnKeyType="search"
						autoCapitalize="none"
						autoCorrect={false}
					/>
				</View>

				<View style={localStyles.chipRow}>
					<View testID="registration-inbox-filter-status-all">
						<ChipButton
							label={t("registrationRequestFilterStatusAll")}
							icon={statusFilter === undefined ? "check" : undefined}
							onPress={() => setStatusFilter(undefined)}
						/>
					</View>
					<View testID="registration-inbox-filter-status-p">
						<ChipButton
							label={t("registrationRequestFilterStatusPending")}
							icon={statusFilter === "p" ? "check" : undefined}
							onPress={() => setStatusFilter("p")}
						/>
					</View>
					<View testID="registration-inbox-filter-status-a">
						<ChipButton
							label={t("registrationRequestFilterStatusApproved")}
							icon={statusFilter === "a" ? "check" : undefined}
							onPress={() => setStatusFilter("a")}
						/>
					</View>
					<View testID="registration-inbox-filter-status-r">
						<ChipButton
							label={t("registrationRequestFilterStatusRejected")}
							icon={statusFilter === "r" ? "check" : undefined}
							onPress={() => setStatusFilter("r")}
						/>
					</View>
				</View>

				<View style={localStyles.chipRow}>
					<View testID="registration-inbox-filter-issuer-all">
						<ChipButton
							label={t("registrationRequestFilterIssuerAll")}
							icon={issuerFilter === undefined ? "check" : undefined}
							onPress={() => setIssuerFilter(undefined)}
						/>
					</View>
					<View testID="registration-inbox-filter-issuer-registrant">
						<ChipButton
							label={t("registrationRequestFilterIssuerRegistrant")}
							icon={issuerFilter === "registrant" ? "check" : undefined}
							onPress={() => setIssuerFilter("registrant")}
						/>
					</View>
					<View testID="registration-inbox-filter-issuer-bridge">
						<ChipButton
							label={t("registrationRequestFilterIssuerBridge")}
							icon={issuerFilter === "bridge" ? "check" : undefined}
							onPress={() => setIssuerFilter("bridge")}
						/>
					</View>
				</View>
			</View>

			{!loadingInitial && (
				<View testID="registration-inbox-count">
					{/* No comparison anywhere between rows.length and total, and this
					    line is never tinted colors.error or colors.warning — the two
					    disagreeing under concurrent mutation is not a bug. */}
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{total !== undefined
							? t("registrationRequestCountLabel", { shown: rows.length, total })
							: t("registrationRequestCountUnknown", { shown: rows.length })}
					</ThemedText>
				</View>
			)}

			{!loadingInitial && (
				<View testID="registration-inbox-sort-label">
					{/* Static text, NOT a control — this phase ships no user-facing
					    sort affordance (UI-SPEC), so there is nothing to press and no
					    state to hold.
					    Why this line exists, and why it names RECEIVED: 48-08 orders
					    the page by `order by R.ReceivedAt asc, R.Id asc` because
					    submittedAt is submitter-supplied (48-02 L-3) and ordering on
					    it would let a submitter buy queue position by backdating.
					    Every row shows BOTH timestamps, so nothing else on the screen
					    would tell the officer which of the two produced the order
					    they are triaging in. A label reading "submitted" over a
					    received-ordered list is a misrepresentation the officer
					    cannot detect — and would invite the next implementer to "fix"
					    the engine to match the label rather than the reverse. THIS
					    LABEL AND THE ENGINE'S ORDER KEY CHANGE TOGETHER OR NOT AT
					    ALL. */}
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationRequestSortedByReceivedLabel")}
					</ThemedText>
				</View>
			)}

			{loadingInitial ? (
				<View testID="registration-inbox-loading">
					{/* Copy-gap: the registrationRequest* group has no dedicated
					    initial-loading key, and 48-03 pins the group's key count, so
					    reuse is deliberate — registrationRequestLoadingMore reused,
					    matching RegistrantsListScreen.tsx's identical gap. */}
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationRequestLoadingMore")}
					</ThemedText>
				</View>
			) : rows.length === 0 ? (
				hasActiveFilters ? (
					<View testID="registration-inbox-empty-filtered">
						<ThemedText type="defaultSemiBold">{t("registrationRequestEmptyHeading")}</ThemedText>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestEmptyBody")}
						</ThemedText>
					</View>
				) : (
					<View testID="registration-inbox-empty-none">
						<ThemedText type="defaultSemiBold">
							{t("registrationRequestEmptyHeadingNoFilters")}
						</ThemedText>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestEmptyBodyNoFilters")}
						</ThemedText>
					</View>
				)
			) : (
				// .map()-in-ScrollView is deliberate: this app has zero
				// virtualized-list-component precedent, and pages are bounded by
				// REGISTRATION_REQUESTS_PAGE_SIZE.
				rows.map((row) => {
					// D-49 (62-31): an unread sealed request is listed honestly instead of as a nameless
					// row. The line carries a key name only, never a payload value.
					const unreadKey = registrationContentUnreadKey(row.payloadAccess);
					return (
						<Fragment key={row.requestId}>
							<RegistrationRequestRow
								row={row}
								// Identifiers only — never the row object, never the display
								// name, never any payload value. React Navigation params are
								// persisted into navigation state and can surface in
								// crash/debug payloads.
								onPress={() =>
									navigation.navigate("RegistrationRequestApproval", {
										requestId: row.requestId,
										authorityId,
									})
								}
							/>
							{unreadKey ? (
								<ThemedText
									type="small"
									style={{ color: colors.textSecondary }}
									testID={"registration-inbox-row-content-" + row.requestId}
								>
									{t(unreadKey)}
								</ThemedText>
							) : null}
						</Fragment>
					);
				})
			)}

			{rows.length > 0 &&
				(loadingMore ? (
					<View testID="registration-inbox-loading-more">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestLoadingMore")}
						</ThemedText>
					</View>
				) : nextCursor !== undefined ? (
					<View testID="registration-inbox-load-more">
						<ChipButton label={t("registrationRequestLoadMoreButton")} onPress={loadMore} />
					</View>
				) : (
					<View testID="registration-inbox-end-of-list">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestEndOfList")}
						</ThemedText>
					</View>
				))}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	chipRow: {
		flexDirection: "row",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export { RegistrationInboxScreen };
