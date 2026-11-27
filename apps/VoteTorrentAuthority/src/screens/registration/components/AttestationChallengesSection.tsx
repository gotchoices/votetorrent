import React, { useCallback, useEffect, useRef, useState } from "react";
import { errorCopy } from "../../../utils/errorCopy";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type {
	AttestationChallenge,
	AttestationVerdict,
	IAssociationEngine,
} from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { CustomButton } from "../../../components/CustomButton";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";
import { useApp } from "../../../providers/AppProvider";
import { createDeviceSigner } from "../../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../../hooks/useDeviceSigningErrorHandler";
import { LifecycleConfirmCard } from "./LifecycleConfirmCard";
import { VerdictBadge } from "./VerdictBadge";
import { latestVerdictByDeviceKey } from "./verdicts";

/**
 * AttestationChallengesSection — the D-11 inspect + expire surface on
 * RegistrantDetailScreen (47-20 composes it in a later wave). It lists every
 * outstanding attestation challenge bound to this registrant, joins the D-03
 * verdict for that challenge's device key, and lets a 'vrg' officer expire a
 * stale challenge behind an ordinary confirmation.
 *
 * D-11 — THE HARDEST RULE ON THIS SURFACE: there is no way, anywhere in this
 * file, to create a fresh device challenge. Challenges bind to a device key
 * this app does not hold, so a challenge minted from this screen would have
 * no device able to answer it — the result would be a permanently stuck
 * record plus the false impression that attestation was requested. This
 * rule has no runtime representation, so it is enforced structurally, twice
 * over: a renderer-free grep gate over this file's own source (co-located
 * negative-space test) and an exact-pressable-set assertion over the
 * rendered tree in every state (co-located behavior test). Do not add a
 * button, a chip, a header action, or an empty-state call to action that
 * would let an officer trigger a new device challenge from here — and do
 * not describe such a control, by its verb, anywhere near a line that
 * actually executes.
 *
 * D-09 — the colors.warning inline banner below is Phase 46's Policy Issues
 * card treatment verbatim, surfaced OUTSIDE the collapsible body so it stays
 * visible even when the section is collapsed (D-08: surfaced where the
 * failure occurs). It reads 47-09's provisioning capability probe
 * read-only; this file never edits AppProvider.tsx, and the probe is called
 * with no optional chaining and no fallback so an absent passthrough is a
 * loud typecheck failure, not a silently suppressed banner.
 *
 * D-03 — the verdict badge is the only honest attestation signal on this
 * row. Phase 45 D-14a..D-14e made the non-attested association path write a
 * non-null identifier on the Association record too, so this file never
 * reads that field — the badge state derives solely from
 * getAttestationVerdicts, reduced to the latest verdict per deviceKey. A
 * device with no verdict row renders the neutral badge, never a false Pass
 * and never a false Fail. An UNREADABLE verdict list renders NO badge at
 * all (T-47-12) — see the `verdicts` state below and AssociationsSection,
 * which holds the identical contract.
 *
 * Purely additive: this file adds no i18n key, no route, no shared
 * component under src/components/, no schema change, and no package. The
 * 'vrg' write gate (`canWrite`) arrives as a prop — this section never
 * calls the officer-scope hook itself.
 */

// A stable no-op for the (non-optional) CustomButton.onPress prop when
// canWrite is false — belt-and-suspenders alongside `disabled` so no
// callback can fire even from a direct programmatic invocation of the
// handler, not just from a blocked touch event.
const NOOP = () => {};

/**
 * toDisplayTimestamp — the display-ready string VerdictBadge and the expiry
 * line both require. VerdictBadge performs NO date formatting by contract
 * (47-10): every timestamp crossing into it must already be display-ready.
 * `formatDate` (utils/displayUtils.ts) takes epoch-ms numbers only, so a
 * string value is parsed first; an unparseable string is returned RAW
 * rather than rendered as the meaningless literal "Invalid Date". Never
 * throws.
 */
export function toDisplayTimestamp(value: string | number | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "number") return formatDate(value);
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return value;
	return formatDate(parsed);
}

export interface AttestationChallengesSectionProps {
	registrantId: string;
	/**
	 * Owner-supplied from the officer-scope hook, keyed by authorityId —
	 * RegistrationFieldsSection / AttestationPolicySection precedent. This
	 * section does NOT call the hook itself; the owning screen resolves it
	 * once for the whole screen.
	 */
	canWrite: boolean;
	/**
	 * Invoked by the D-09 banner's tap-through. A callback, not a
	 * navigation.navigate call — the provisioning-status route is added by
	 * a later-wave plan, so a typed navigate here would not compile yet.
	 */
	onOpenProvisioningStatus: () => void;
	testIDPrefix?: string;
}

export function AttestationChallengesSection({
	registrantId,
	canWrite,
	onOpenProvisioningStatus,
	testIDPrefix = "attestation-challenges",
}: AttestationChallengesSectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine, isAttestationVerifierProvisioned } = useApp();

	// D-09: a bare synchronous getter. No await, no effect, no optional
	// chaining, and no `?? true` fallback — a missing passthrough must
	// surface as a loud typecheck failure, not as a silently suppressed
	// banner.
	const provisioned = isAttestationVerifierProvisioned();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Default-open per the phase's default-open collapsible group.
	const [expanded, setExpanded] = useState(true);
	const [challenges, setChallenges] = useState<AttestationChallenge[]>([]);
	// `undefined` means the verdict list could not be read — NOT the same as
	// "no verdict rows exist" (an empty Map). Load-bearing for T-47-12, and
	// the same shape AssociationsSection holds: a read failure must render no
	// badge at all, never the honest-looking "none" state.
	const [verdicts, setVerdicts] = useState<Map<string, AttestationVerdict> | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState("");
	// The FULL nonce of the challenge whose confirmation is open — a single
	// scalar, so at most ONE confirm card can ever be open section-wide.
	const [pendingExpireNonce, setPendingExpireNonce] = useState<string | null>(null);

	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const load = useCallback(async () => {
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<IAssociationEngine>("association");
			// Always registrant-narrowed — the no-arg form returns every
			// outstanding challenge in the local DB, which is not this
			// surface's scope.
			const rows = await engine.getAttestationChallenges(registrantId);
			if (!unmountedRef.current) setChallenges(rows);

			// Verdicts — independent try/catch, deliberately isolated from
			// the block above. A verdict-read failure never becomes an error
			// banner: the challenge list is the primary content and must
			// render regardless of this read's outcome. But it degrades to
			// NO badge, not to the neutral one. "none" is not a null value —
			// it is an affirmative claim that no verdict was recorded, which
			// a failed read does not know, and on this surface it would read
			// as an all-clear for a device whose real verdict may be a fail
			// (T-47-12). Hence `undefined`, NOT an empty Map: an empty Map
			// says "every device here has no verdict", which is exactly the
			// unearned assertion. See AssociationsSection:107-111.
			try {
				const verdictRows = await engine.getAttestationVerdicts(registrantId);
				if (!unmountedRef.current) setVerdicts(latestVerdictByDeviceKey(verdictRows));
			} catch {
				if (!unmountedRef.current) setVerdicts(undefined);
			}
		} catch (err) {
			// The handler's navigation branch must also respect unmountedRef.
			const outcome = unmountedRef.current
				? { handled: false, message: undefined }
				: handleDeviceSigningError(err);
			if (!unmountedRef.current && !outcome.handled) {
				setErrorMessage(outcome.message ?? errorCopy(err, t, "read", { log: false }));
			}
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
		// handleDeviceSigningError is deliberately excluded from this dependency
		// list: it is a useCallback-stabilized function in production, but its
		// identity is only as stable as the i18n `t` function it closes over —
		// re-including it here would re-trigger the mount effect below whenever
		// that upstream identity shifts (observed as an infinite render loop
		// against a non-memoized test double for useTranslation). `load` only
		// needs the CURRENT handler at call time, which the closure always has.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registrantId, getEngine]);

	// Load unconditionally on mount — never gated on `expanded`, or a
	// collapsed section would silently hide a load failure.
	useEffect(() => {
		load();
	}, [load]);

	// The rethrow below is load-bearing — LifecycleConfirmCard returns to
	// `idle` only on a REJECTED onConfirm, so swallowing the error here
	// would latch the card `submitted` and strand the officer with a
	// permanently disabled, still-mounted confirmation.
	async function handleExpire(nonce: string) {
		try {
			// Both of these are INSIDE the try, mirroring
			// AssociationsSection.handleRemove. createDeviceSigner throws
			// ('Device user not initialised — cannot sign') and getEngine throws
			// (NoNetworkEstablishedError); outside the try neither set an
			// errorMessage, so LifecycleConfirmCard caught the rejection, reset
			// to idle, and the officer saw the confirm button simply re-enable
			// with nothing else happening — a silent failure on a signed write.
			const sign = await createDeviceSigner("Device User");
			const engine = await getEngine<IAssociationEngine>("association");
			await engine.removeAttestationChallenge(nonce, sign);
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
		if (!unmountedRef.current) {
			setErrorMessage("");
			setPendingExpireNonce(null);
		}
		await load();
	}

	return (
		<View testID={`${testIDPrefix}-section`} style={styles.section}>
			{/* D-11: this toggle is the section's ONLY header action. */}
			<View testID={`${testIDPrefix}-toggle`}>
				<ChipButton
					label={t("attestationChallengeSectionTitle")}
					icon={expanded ? "chevron-down" : "chevron-right"}
					onPress={() => setExpanded((o) => !o)}
				/>
			</View>

			{/* D-09/D-08: banner sits OUTSIDE the expanded body so it survives collapse. */}
			{!provisioned && (
				<View
					testID={`${testIDPrefix}-provisioning-banner`}
					style={[
						styles.cardSurface,
						{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning },
					]}
				>
					<View style={localStyles.bannerHeadingRow}>
						<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} />
						<ThemedText type="small">{t("attestationProvisioningInlineBannerBody")}</ThemedText>
					</View>
					{/* The link is never scope-gated — provisioning is a build/device concern, not registrant data. */}
					<View testID={`${testIDPrefix}-provisioning-link`}>
						<ChipButton
							label={t("attestationProvisioningInlineBannerLink")}
							onPress={onOpenProvisioningStatus}
						/>
					</View>
				</View>
			)}

			{expanded && (
				<View style={localStyles.sectionRow}>
					<View testID={`${testIDPrefix}-error`}>
						<InlineError message={errorMessage} />
					</View>

					{loading && (
						<View testID={`${testIDPrefix}-loading`}>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("loading")}
							</ThemedText>
						</View>
					)}

					{/* D-11: purely informational — no chip, no button, nothing pressable here. */}
					{!loading && challenges.length === 0 && (
						<View testID={`${testIDPrefix}-empty`}>
							<ThemedText type="defaultSemiBold">
								{t("attestationChallengeEmptyHeading")}
							</ThemedText>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("attestationChallengeEmptyBody")}
							</ThemedText>
						</View>
					)}

					{!loading &&
						challenges.map((c) => {
							const v = verdicts?.get(c.deviceKey);
							const expireDisabled = !canWrite;
							return (
								<View
									key={c.nonce}
									testID={`${testIDPrefix}-row-${c.nonce}`}
									style={[styles.cardSurface, { backgroundColor: colors.card }]}
								>
									<View testID={`${testIDPrefix}-device-key-${c.nonce}`} style={localStyles.row}>
										<ThemedText type="tiny">
											{t("attestationChallengeDeviceKeyLabel") +
												": " +
												c.deviceKey.slice(0, 5) +
												"..."}
										</ThemedText>
									</View>

									{/* Unbound electionId renders "—", never omitted (Assumption A5). */}
									<View testID={`${testIDPrefix}-election-${c.nonce}`} style={localStyles.row}>
										<ThemedText type="tiny">
											{t("attestationChallengeElectionLabel") + ": " + (c.electionId ?? "—")}
										</ThemedText>
									</View>

									{/* D-10 (51-05): AttestationChallenge.Expiration removed — no expiry row to render.
									    Single-use is now enforced by D-11 consumption in associate(), not a TTL. */}

									{/* D-03: verdict is the only honest signal; never reads the non-null identifier field.
									    T-47-12: omitted entirely when the verdict list could not be read — see `verdicts`. */}
									{verdicts && (
										<VerdictBadge
											testIDPrefix={`${testIDPrefix}-verdict-${c.nonce}`}
											verdict={v?.verdict}
											reason={v?.reason}
											verifiedAt={toDisplayTimestamp(v?.verifiedAt)}
										/>
									)}

									<View style={localStyles.row}>
										<View testID={`${testIDPrefix}-expire-trigger-${c.nonce}`}>
											<CustomButton
												size="thin"
												title={t("attestationChallengeExpireButton")}
												backgroundColor={colors.error}
												disabled={expireDisabled}
												onPress={!expireDisabled ? () => setPendingExpireNonce(c.nonce) : NOOP}
											/>
										</View>
									</View>

									{/* Single scalar — pressing another row's trigger REPLACES this card, never stacks. */}
									{pendingExpireNonce === c.nonce && (
										<LifecycleConfirmCard
											variant="ordinary"
											tone="destructive"
											testIDPrefix={`${testIDPrefix}-expire-${c.nonce}`}
											title={t("attestationChallengeExpireTitle")}
											body={t("attestationChallengeExpireBody")}
											confirmLabel={t("attestationChallengeExpireConfirm")}
											dismissLabel={t("attestationChallengeKeepChallenge")}
											onConfirm={() => handleExpire(c.nonce)}
											onDismiss={() => setPendingExpireNonce(null)}
										/>
									)}
								</View>
							);
						})}
				</View>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	sectionRow: {
		gap: 8,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
	bannerHeadingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
