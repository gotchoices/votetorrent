import React, { useCallback, useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useFocusEffect, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { IReassociationEngine, ReassociationReview } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { InlineError } from "../../../components/InlineError";
import { globalStyles } from "../../../theme/styles";
import { useApp } from "../../../providers/AppProvider";
import {
	isPeerReviewUnavailable,
	openPeerReviewSession,
	readOnlyReviewSign,
	reassociationRegistrantLabel,
	type PeerReviewSession,
} from "../continuity-review";
import type { RootStackParamList } from "../../../navigation/types";

/**
 * ReassociationQueueSection — the registration inbox's entry to pending device-change requests
 * (D-41/D-46). Device-change requests awaiting an officer are reached from the inbox;
 * `AssociationRequestStatusScreen` stays control-free (Phase 51).
 *
 * Read-only: the peer review session is opened with `readOnlyReviewSign`, so it can never sign,
 * and is closed after every load. This file never calls `createDeviceSigner`.
 *
 * Absence is the signal: no transport factory (no peer network), or an empty queue, renders
 * nothing. Any other failure renders the load-error key, never an engine message.
 *
 * Never-log rule: a registrant name is untrusted display data with exactly one destination, its
 * row title. No console calls.
 */
export interface ReassociationQueueSectionProps {
	authorityId: string;
}

export function ReassociationQueueSection({ authorityId }: ReassociationQueueSectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine, createPeerStagingTransports } = useApp();
	const [reviews, setReviews] = useState<ReassociationReview[]>([]);
	const [failed, setFailed] = useState(false);

	useFocusEffect(
		useCallback(() => {
			let cancelled = false;
			async function load() {
				let session: PeerReviewSession | undefined;
				try {
					session = await openPeerReviewSession({
						getEngine,
						createPeerStagingTransports,
						authorityId,
						sign: readOnlyReviewSign,
					});
					const engine = await getEngine<IReassociationEngine>("association");
					const list = await engine.listPendingReassociations(authorityId, session.association, session.opener);
					if (cancelled) return;
					setReviews(list);
					setFailed(false);
				} catch (err) {
					if (cancelled) return;
					if (isPeerReviewUnavailable(err)) {
						setReviews([]);
						setFailed(false);
					} else {
						setFailed(true);
					}
				} finally {
					if (session) await session.close();
				}
			}
			void load();
			return () => {
				cancelled = true;
			};
		}, [getEngine, createPeerStagingTransports, authorityId])
	);

	if (failed) {
		return (
			<View testID="reassociation-queue-error">
				<InlineError message={t("associationApprovalLoadError")} />
			</View>
		);
	}
	if (reviews.length === 0) return null;

	return (
		<View testID="reassociation-queue">
			<ThemedText type="defaultSemiBold">{t("registrationPolicyReassociationHeading")}</ThemedText>
			{reviews.map((review) => (
				<TouchableOpacity
					key={review.requestId}
					testID={`reassociation-queue-row-${review.requestId}`}
					accessibilityRole="button"
					onPress={() =>
						// Identifiers only: never the review, never a name.
						navigation.navigate("AssociationRequestApproval", { requestId: review.requestId, authorityId })
					}
					style={[styles.cardSurface, localStyles.row, { backgroundColor: colors.card }]}
				>
					<ThemedText type="default" style={localStyles.title}>
						{t("associationApprovalQueueRowTitle", { registrantName: reassociationRegistrantLabel(review) })}
					</ThemedText>
					<FontAwesome6 name="chevron-right" size={16} color={colors.textSecondary} />
				</TouchableOpacity>
			))}
		</View>
	);
}

const localStyles = StyleSheet.create({
	// 44 pt minimum touch target, stretched; the title wraps in full.
	row: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "stretch",
		minHeight: 44,
		gap: 8,
	},
	title: {
		flexShrink: 1,
		flexGrow: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
