import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { AssociationRequestRead, AssociationRequestStatus, IAssociationEngine } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";

/**
 * AssociationRequestStatusScreen — the D-06 read-only association-request
 * status surface, sited BESIDE `AttestationProvisioningStatusScreen.tsx`
 * (D-06's stated siting) and copying its control-free precedent exactly —
 * the strictest available reading of D-06's "read-only".
 *
 * D-05 says association processing is authority-VERIFIED, not
 * officer-APPROVED — there is no per-request human decision to model, so
 * this screen is DELIBERATELY NOT the `RegistrationInboxScreen` /
 * `RegistrationRequestApprovalScreen` pattern: reusing an approve/reject UI
 * would imply an approval semantic that does not exist. D-19 sites the
 * actual processing TRIGGER inside the EXISTING "Sync Now" mechanism
 * (`bulk-import-sync-model.ts` / `attach-association-sync-bindings.ts`)
 * instead of adding any control to this screen.
 *
 * THERE IS NO PRESSABLE CONTROL ANYWHERE ON THIS SCREEN. No approve, no
 * reject, no retry, no "Sync Now". There is deliberately no inline-error
 * banner either — a read failure resolves to the same empty/neutral state
 * as "no requests yet" via `resolveAssociationRequestRows` below, mirroring
 * `AttestationProvisioningStatusScreen.tsx`'s own fail-conservative
 * discipline (T-47-01).
 *
 * THE ONE DATA PATH: `getEngine<IAssociationEngine>("association")` then a
 * single call to `listAssociationRequests`, passing `authorityId` — the
 * signature 51-04 declared on `IAssociationEngine` and 51-09 implemented on
 * `AssociationEngine`. No `status` argument is passed: this screen shows
 * every state at once, so filtering (if ever added) must stay client-side
 * to keep this the only call site. The engine's single-row lookup method is
 * never called here — this screen has no detail route.
 *
 * NO PII: only `status`, `submittedAt`, `receivedAt`, and (for a `'c'` row)
 * the PRESENCE of a challenge nonce reach this screen — never the nonce's
 * value, never a registrant name/email/phone/address. `submittedAt` and
 * `receivedAt` are rendered as two SEPARATE labelled values; one is never
 * substituted for the other.
 */

/**
 * The T-47-01-style fail-conservative boundary for this screen: resolves to
 * an EMPTY LIST whenever `probe()` rejects, or resolves to anything other
 * than a real array — never `undefined`, never a partially-populated row. A
 * status screen that crashes the app because a read failed is worse than
 * one that shows nothing.
 */
export async function resolveAssociationRequestRows(
	probe: () => Promise<AssociationRequestRead[]>,
): Promise<AssociationRequestRead[]> {
	try {
		const rows = await probe();
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}

/**
 * The ONE discriminant producing the testID suffix and the status label key
 * together, mirroring `provisioningCopy`'s pairing-lock discipline so a
 * status can never render beside the wrong label.
 */
export function associationRequestStatusCopy(status: AssociationRequestStatus): {
	testIDSuffix: string;
	labelKey: string;
} {
	switch (status) {
		case "p":
			return { testIDSuffix: "pending", labelKey: "associationRequestStatusPendingLabel" };
		case "c":
			return { testIDSuffix: "challenge-issued", labelKey: "associationRequestStatusChallengeIssuedLabel" };
		case "a":
			return { testIDSuffix: "associated", labelKey: "associationRequestStatusAssociatedLabel" };
		case "r":
			return { testIDSuffix: "rejected", labelKey: "associationRequestStatusRejectedLabel" };
	}
}

interface AssociationRequestStatusRouteParams {
	authorityId: string;
}

export default function AssociationRequestStatusScreen() {
	const insets = useSafeAreaInsets();
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const { authorityId } = useRoute().params as AssociationRequestStatusRouteParams;

	const [rows, setRows] = useState<AssociationRequestRead[]>([]);
	const [loading, setLoading] = useState(true);

	// CR-02-class guard against a stale setState after unmount (this app's
	// established convention — see AssociationsSection.tsx).
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const load = useCallback(async () => {
		if (!unmountedRef.current) setLoading(true);
		const result = await resolveAssociationRequestRows(async () => {
			const engine = await getEngine<IAssociationEngine>("association");
			return engine.listAssociationRequests(authorityId);
		});
		if (!unmountedRef.current) {
			setRows(result);
			setLoading(false);
		}
	}, [getEngine, authorityId]);

	useEffect(() => {
		load();
	}, [load]);

	const showEmpty = !loading && rows.length === 0;

	return (
		<ScrollView
			testID="association-request-status-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			{showEmpty && (
				<View
					testID="association-request-status-empty"
					style={[styles.cardSurface, { backgroundColor: colors.card }]}
				>
					<ThemedText type="defaultSemiBold" testID="association-request-status-empty-heading">
						{t("associationRequestStatusEmptyHeading")}
					</ThemedText>
					<ThemedText
						type="default"
						style={localStyles.bodyText}
						testID="association-request-status-empty-body"
					>
						{t("associationRequestStatusEmptyBody")}
					</ThemedText>
				</View>
			)}

			{rows.map((row) => {
				const copy = associationRequestStatusCopy(row.status);
				const statusColor =
					row.status === "a" ? colors.success : row.status === "r" ? colors.error : colors.warning;
				const rowTestID = `association-request-status-row-${row.requestId}`;

				return (
					<View
						key={row.requestId}
						testID={rowTestID}
						style={[
							styles.cardSurface,
							{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: statusColor },
						]}
					>
						<View style={localStyles.headingRow}>
							<View testID={`${rowTestID}-icon`}>
								<FontAwesome6 name="shield-halved" size={16} color={statusColor} />
							</View>
							<ThemedText type="defaultSemiBold" testID={`${rowTestID}-status`}>
								{t(copy.labelKey)}
							</ThemedText>
						</View>

						<ThemedText type="default" style={localStyles.bodyText} testID={`${rowTestID}-submitted-at`}>
							{t("associationRequestStatusSubmittedAtLabel")}: {row.submittedAt}
						</ThemedText>

						<ThemedText type="default" testID={`${rowTestID}-received-at`}>
							{t("associationRequestStatusReceivedAtLabel")}: {row.receivedAt}
						</ThemedText>

						{/* Presence only — never the nonce's value (T-51-10-03). A 'c' row
						    always has a nonce by construction; this line simply names that
						    fact for the officer, it never reads row.challengeNonce. */}
						{row.status === "c" && (
							<ThemedText type="small" testID={`${rowTestID}-challenge`}>
								{t("associationRequestStatusChallengeIssuedNote")}
							</ThemedText>
						)}
					</View>
				);
			})}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	headingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	bodyText: {
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
