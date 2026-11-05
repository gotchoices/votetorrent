import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { Association, AttestationVerdict, IAssociationEngine } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { ChipButton } from "../../../components/ChipButton";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";
import { useApp } from "../../../providers/AppProvider";
import { createDeviceSigner } from "../../../engines/device-signer";
import { useCurrentOfficerScopes } from "../../../hooks/useCurrentOfficerScopes";
import { useDeviceSigningErrorHandler } from "../../../hooks/useDeviceSigningErrorHandler";
import { LifecycleConfirmCard } from "./LifecycleConfirmCard";
import { VerdictBadge } from "./VerdictBadge";
import { latestVerdictByDeviceKey } from "./verdicts";
import { errorCopy } from "../../../utils/errorCopy";

/**
 * AssociationsSection — the default-open "Associated Devices" collapsible on
 * `RegistrantDetailScreen` (47-20 composes it in Wave 4). It lists every
 * device bound to a registrant, shows whether that device's attestation was
 * actually verified, and lets a `'vrg'` officer revoke a binding behind an
 * inline confirmation.
 *
 * D-03 — the verdict is the ONLY honest attestation signal. Phase 45
 * D-14a..D-14e made the non-attested association path write a minimal
 * AssociationPrivate too, so `Association.attestationCid` is non-null on
 * BOTH the attested and the non-attested paths. This component therefore
 * NEVER reads `attestationCid` — the badge state derives solely from
 * `getAttestationVerdicts`, reduced to the latest verdict per deviceKey.
 * (Any mention of the field name above this point is a comment-only line.)
 *
 * D-10 — removal uses the ORDINARY `LifecycleConfirmCard` variant with
 * `tone="destructive"` — re-association is possible and `Registrant.Status`
 * is untouched, so this does not meet D-10's typed-match destructive bar,
 * but it is still a delete and is never a silent single-tap action.
 *
 * D-13 — `canWrite` derives from `useCurrentOfficerScopes(authorityId)`.
 * This gate is a legibility affordance, NOT the enforcement boundary — the
 * schema's `'vrg'` AdminSignature CHECK on Association's delete is the real
 * and only control (T-47-04). Write controls render visible-but-disabled.
 * This section renders no banner — 47-20 owns the screen-level banner.
 */

// A stable no-op for the (non-optional) CustomButton.onPress prop when a
// gate is unmet — belt-and-suspenders alongside `disabled` so no callback
// can fire even from a direct programmatic invocation of the handler, not
// just from a blocked touch event.
const NOOP = () => {};

/**
 * truncateDeviceKey — the `HistoryEvent.tsx:109` truncation convention
 * reused here (T-47-05): the full device key must never reach the rendered
 * tree, only a 5-character prefix.
 */
export function truncateDeviceKey(deviceKey: string): string {
	return deviceKey.slice(0, 5) + "...";
}

/**
 * formatTimestamp — bridges `formatDate`'s epoch-ms `number` contract and
 * the engine's `Timestamp | string` shape (ISO-Z on the real engine, ISO on
 * the mock). Returns `undefined` for an absent or unparseable value rather
 * than `formatDate`'s `'N/A'` sentinel: `VerdictBadge` treats an absent
 * `verifiedAt` by omitting the line entirely, whereas an `'N/A'` string
 * would render a meaningless label.
 */
export function formatTimestamp(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const ms = typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(ms)) return undefined;
	return formatDate(ms);
}

export interface AssociationsSectionProps {
	registrantId: string;
	authorityId: string;
	/**
	 * Public-tier display name (never a private-tier value) used only for the
	 * `{{name}}` interpolation in `associationListRemoveBody`. 47-20 supplies
	 * the registrant's public display name, falling back to a truncated
	 * `Registrant.Id` per 47-UI-SPEC.md:224-228.
	 */
	registrantDisplayName: string;
}

export function AssociationsSection({
	registrantId,
	authorityId,
	registrantDisplayName,
}: AssociationsSectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();

	// D-13 scope gate. T-47-04: this is a legibility affordance, not the
	// enforcement boundary — the schema's 'vrg' AdminSignature CHECK on
	// Association's delete is the real and only control, and an officer who
	// ignores this gate cannot thereby delete anything.
	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("vrg") === true;
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Section is default-open per 47-UI-SPEC.md:654.
	const [open, setOpen] = useState(true);
	const [associations, setAssociations] = useState<Association[]>([]);
	// `undefined` means verdicts could not be read — NOT the same as "no
	// verdicts exist" (an empty Map). Load-bearing for T-47-12: a read
	// failure must render no badge at all, never the honest-looking "none"
	// state, because "none" would assert something this section does not
	// know.
	const [verdictMap, setVerdictMap] = useState<Map<string, AttestationVerdict> | undefined>(undefined);
	const [dataLoading, setDataLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
	// The FULL deviceKey of the association whose confirmation is open — never
	// an array index (T-47-13): a re-fetch or re-order between opening and
	// confirming would retarget an index-keyed confirmation at a different
	// device.
	const [pendingRemoveKey, setPendingRemoveKey] = useState<string | undefined>(undefined);

	// CR-02 guard against a stale setState after unmount. Reset on entry so a
	// cleanup that runs while the component stays mounted (StrictMode
	// double-invoke, Fast Refresh, remount-in-place) does not permanently latch
	// every setState off. Without the reset this section is the one sibling that
	// latches: `dataLoading` never leaves `true`, so it renders "Loading…"
	// forever and a device revocation never re-reads.
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const load = useCallback(async () => {
		setDataLoading(true);

		// Inside a try, mirroring AttestationChallengesSection.load(). getEngine
		// reaches EngineFactory.buildEngine → requireEstablishedCtx(), which
		// throws NoNetworkEstablishedError when the network context is absent or
		// has just been switched. Outside the try, that rejection escaped load()
		// into `useEffect(() => { load(); })` — a floating promise with no
		// .catch — producing an unhandled rejection, dataLoading stuck at true,
		// and no InlineError telling the officer anything went wrong.
		let engine: IAssociationEngine;
		try {
			engine = await getEngine<IAssociationEngine>("association");
		} catch (err) {
			if (!unmountedRef.current) {
				setAssociations([]);
				setVerdictMap(undefined);
				setErrorMessage(errorCopy(err, t, "read", { log: false }));
				setDataLoading(false);
			}
			return;
		}

		// Associations — independent try/catch #1.
		let rows: Association[] = [];
		try {
			rows = await engine.getAssociations(registrantId);
			if (!unmountedRef.current) {
				setAssociations(rows);
				setErrorMessage(undefined);
			}
		} catch (err) {
			if (!unmountedRef.current) {
				setAssociations([]);
				setErrorMessage(errorCopy(err, t, "read", { log: false }));
				setVerdictMap(undefined);
				setDataLoading(false);
			}
			// Nothing to badge without a roster — return early.
			return;
		}

		// Verdicts — independent try/catch #2. A verdict-read failure must
		// never blank the roster (the same discipline D-05 applies to a
		// failed count query on the registrants list) and must never be
		// rendered as "no verdict yet" — omitting the badge asserts nothing,
		// whereas the no-verdict badge would assert something the section
		// does not know (T-47-12).
		try {
			const verdicts = await engine.getAttestationVerdicts(registrantId);
			if (!unmountedRef.current) setVerdictMap(latestVerdictByDeviceKey(verdicts));
		} catch (err) {
			if (!unmountedRef.current) {
				setVerdictMap(undefined);
				setErrorMessage(errorCopy(err, t, "read", { log: false }));
			}
		}

		if (!unmountedRef.current) setDataLoading(false);
	}, [getEngine, registrantId]);

	useEffect(() => {
		load();
	}, [load]);

	// The rethrow below is load-bearing — LifecycleConfirmCard returns to
	// `idle` only on a REJECTED onConfirm, so swallowing the error would
	// latch the card `submitted` and strand the officer with a permanently
	// disabled, still-mounted confirmation. LifecycleConfirmCard awaits
	// onConfirm inside its own try/catch, so this throw cannot escape as an
	// unhandled rejection.
	async function handleRemove(deviceKey: string) {
		try {
			const sign = await createDeviceSigner("Device User");
			const engine = await getEngine<IAssociationEngine>("association");
			await engine.removeAssociation(registrantId, deviceKey, sign);
			if (!unmountedRef.current) setPendingRemoveKey(undefined);
			await load();
		} catch (err) {
			// The handler's navigation branch must also respect unmountedRef —
			// do not navigate away from a component that has already unmounted.
			const outcome = unmountedRef.current
				? { handled: false, message: undefined }
				: handleDeviceSigningError(err);
			if (!unmountedRef.current && !outcome.handled) {
				setErrorMessage(outcome.message ?? errorCopy(err, t, "write", { log: false }));
			}
			throw err;
		}
	}

	return (
		<View testID="associations-section" style={styles.section}>
			<View testID="associations-section-toggle">
				{/* ChipButton wires onPress to the native onPressIn — the suite must
				    press it via onPressIn. */}
				<ChipButton
					label={t("associationListSectionTitle")}
					icon={open ? "chevron-down" : "chevron-right"}
					onPress={() => setOpen((o) => !o)}
				/>
			</View>

			{open && (
				<>
					<InlineError message={errorMessage} />

					{dataLoading && (
						<ThemedText type="small" style={{ color: colors.textSecondary }} testID="associations-loading">
							{t("loading")}
						</ThemedText>
					)}

					{!dataLoading && associations.length === 0 && (
						<View testID="associations-empty">
							<ThemedText type="defaultSemiBold">{t("associationListEmptyHeading")}</ThemedText>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("associationListEmptyBody")}
							</ThemedText>
						</View>
					)}

					{!dataLoading &&
						associations.map((association, index) => {
							const verdict = verdictMap?.get(association.deviceKey);
							// At most one confirmation may be open section-wide — stricter
							// than 47-10's per-row testIDPrefix allowance, deliberate: two
							// open destructive confirmations on one screen is a mis-tap
							// surface, not a feature.
							const removeDisabled = !canWrite || pendingRemoveKey !== undefined;
							return (
								<View
									key={association.deviceKey}
									testID={`association-row-${index}`}
									style={[styles.cardSurface, { backgroundColor: colors.card }]}
								>
									<View style={localStyles.propertyRow}>
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{t("associationListDeviceKeyLabel")}
										</ThemedText>
										<ThemedText type="tiny" testID={`association-row-${index}-device-key`}>
											{truncateDeviceKey(association.deviceKey)}
										</ThemedText>
									</View>

									<View style={localStyles.propertyRow}>
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{t("associationListExpirationLabel")}
										</ThemedText>
										<ThemedText type="tiny">
											{formatTimestamp(association.expiration) ?? String(association.expiration)}
										</ThemedText>
									</View>

									{/* T-47-12: this is the ONLY source of the attestation
									    signal. A device with no entry in the map yields
									    verdict === undefined, which VerdictBadge resolves to
									    its honest "none" state. Rendered only when
									    verdictMap !== undefined — a verdict-read failure omits
									    the badge entirely rather than rendering a false
									    no-verdict claim. */}
									{verdictMap && (
										<VerdictBadge
											testIDPrefix={`association-verdict-${index}`}
											verdict={verdict?.verdict}
											reason={verdict?.reason}
											verifiedAt={formatTimestamp(verdict?.verifiedAt)}
										/>
									)}

									<View style={localStyles.rowBody}>
										<View testID={`association-remove-button-${index}`}>
											<CustomButton
												size="thin"
												title={t("associationListRemoveButton")}
												backgroundColor={colors.error}
												disabled={removeDisabled}
												onPress={
													!removeDisabled ? () => setPendingRemoveKey(association.deviceKey) : NOOP
												}
											/>
										</View>

										{pendingRemoveKey === association.deviceKey && (
											<LifecycleConfirmCard
												variant="ordinary"
												tone="destructive"
												testIDPrefix={`association-remove-${index}`}
												title={t("associationListRemoveTitle")}
												body={t("associationListRemoveBody", { name: registrantDisplayName })}
												confirmLabel={t("associationListRemoveConfirm")}
												dismissLabel={t("associationListKeepAssociation")}
												onConfirm={() => handleRemove(association.deviceKey)}
												onDismiss={() => setPendingRemoveKey(undefined)}
											/>
										)}
									</View>
								</View>
							);
						})}
				</>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	propertyRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
	rowBody: {
		gap: 6,
	},
});

const styles = { ...globalStyles, ...localStyles };
