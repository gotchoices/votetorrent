import React, { useCallback, useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Share } from "react-native";
import { ExtendedTheme, useRoute, useTheme, useNavigation, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import type { BallotSummary, ElectionDetails, IElectionEngine, ElectionRevisionSignatureTask } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";
import { ElectionDetailsBlock } from "./components/ElectionDetailsBlock";
import { ElectionTimelineList } from "./components/ElectionTimelineList";
import { ChipButton } from "../../components/ChipButton";
import { KeyholderCard } from "./components/KeyholderCard";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { formatDate } from "../../utils/displayUtils";
import type { NavigationProp } from "../../navigation/types";

/**
 * ElectionDetailsScreen — Figma parity #13/#18/#19 per Phase 9 plan 09-14.
 *
 * Render order (top → bottom):
 *   1.  ElectionDetailsBlock — immutable core (title, Authority, Type, Date-time, Core Sig)
 *   2.  Current revision section (Revision #N + date, Tags, Timeline text list,
 *       Keyholder Policy, Revision Signature, PREVIEW chip)
 *   3.  Keyholders — Sent/Unsent cards + chevron
 *   4.  REVISE ELECTION / CLONE ELECTION actions
 *   5.  Proposed Revision block (conditional — only when electionDetails.proposed exists)
 *       · revision header, tags, timeline text list, keyholder policy
 *       · signing rows per keyholder (SIGN accent / SHARE warning CustomButton pills)
 *       · ADJUST REVISION → EditElectionRevision
 *   6.  Ballot Templates section (one InfoCard per template with Questions subtitle)
 *   7.  More section (collapsible) + filter-authorities input
 */
export default function ElectionDetailsScreen() {
	const { t } = useTranslation();
	const { electionEngine } = useRoute().params as { electionEngine: IElectionEngine };
	const [electionDetails, setElectionDetails] = useState<ElectionDetails | null>(null);
	const [ballots, setBallots] = useState<BallotSummary[]>([]);
	const [moreOpen, setMoreOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

	useEffect(() => {
		const loadElectionDetails = async () => {
			try {
				if (electionEngine) {
					const details = await electionEngine.getElectionDetails();
					setElectionDetails(details);
				}
			} catch (error) {
				console.error("Error loading election details:", error);
				setErrorMessage(error instanceof Error ? error.message : String(error));
			}
		};

		loadElectionDetails();
	}, [electionEngine]);

	// G2/G12: Refresh ballot list on every focus so newly proposed templates appear
	// immediately on return from CreateBallot/EditBallot.
	useFocusEffect(
		useCallback(() => {
			const loadBallots = async () => {
				try {
					if (electionEngine) {
						const summaries = await electionEngine.getBallots();
						setBallots(summaries);
					}
				} catch (error) {
					console.error("Error loading ballots:", error);
					setErrorMessage(error instanceof Error ? error.message : String(error));
				}
			};
			loadBallots();
		}, [electionEngine])
	);

	const handleShare = async (election: ElectionDetails["election"], proposed: ElectionDetails["proposed"], current: ElectionDetails["current"]) => {
		try {
			const message = [
				`Election: ${election.title}`,
				`Revision: #${proposed?.proposed.revision ?? current.revision}`,
				`Authority: ${election.authorityId}`,
				`Date: ${formatDate(election.date)}`,
			].join("\n");
			await Share.share({ message });
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	};

	if (!electionDetails) {
		return (
			<View style={styles.container}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	const { election, current, proposed } = electionDetails;
	const revisionSignature = (current as any).signature?.signature as string | undefined;
	const revisionDate = Array.isArray(current.revisionTimestamp) && current.revisionTimestamp.length > 0
		? (current.revisionTimestamp[0] as unknown as number)
		: election.date;

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>

			{/* SC6 error state — surfaces load failures inline (D-19) */}
			{errorMessage ? (
				<View style={styles.section}>
					<ThemedText type="small" style={{ color: colors.error }}>{errorMessage}</ThemedText>
				</View>
			) : null}

			{/* 1. Immutable core block (title + Authority/Type/Date + Core Signature) */}
			<View style={styles.section}>
				<ElectionDetailsBlock electionDetails={electionDetails} />
			</View>

			{/* 2. Current revision section — rendered ONCE here */}
			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
					<ThemedText>#{current.revision} - {formatDate(revisionDate)}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
					<ThemedText>{current.tags.join(", ")}</ThemedText>
				</View>

				{/* Timeline — text list per Decision 2 */}
				<ThemedText type="defaultSemiBold" style={styles.sectionLabel}>{t("timeline")}</ThemedText>
				<ElectionTimelineList timeline={current.timeline} />

				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
					<ThemedText>{current.keyholderThreshold} of {current.keyholders.length}</ThemedText>
				</View>

				{revisionSignature ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revisionSignature")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle">{revisionSignature}</ThemedText>
					</View>
				) : null}

				{/* PREVIEW chip — EUI-05/D-09: navigate to EditBallot in read-only mode.
				    WR-07: only show the single top-level PREVIEW when there is exactly
				    one template — otherwise it would silently preview only ballots[0].
				    With multiple templates the per-template cards below are the
				    unambiguous per-ballot entry points. */}
				{ballots.length === 1 ? (
					<ChipButton
						label={t("previewBallots")}
						onPress={() => {
							navigation.navigate("EditBallot", {
								electionId: election.id,
								electionTitle: election.title,
								electionDate: formatDate(election.revisionDeadline),
								ballotId: ballots[0].id,
								electionEngine,
								readOnly: true,
							} as any);
						}}
					/>
				) : null}
			</View>

			{/* 3. Keyholders — Sent/Unsent + chevron */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("keyholders")}</ThemedText>
				{current.keyholders.map((keyholder, index) => (
					<KeyholderCard
						key={keyholder.invite?.name ?? `keyholder-${index}`}
						invitationStatus={keyholder}
						onPress={() => navigation.navigate("Keyholder", { keyholder, electionEngine })}
					/>
				))}
				<CustomButton
					title={t("invite")}
					icon="paper-plane"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() => navigation.navigate("KeyholderInvitation", { mode: "send", electionEngine })}
				/>
			</View>

			{/* 4. REVISE / CLONE actions */}
			<View style={styles.section}>
				<CustomButton
					title={t("reviseElection")}
					size="thin"
					icon="pencil"
					backgroundColor={colors.accent}
					onPress={() => navigation.navigate("EditElectionRevision", { electionEngine })}
				/>
				<CustomButton
					title={t("cloneElection")}
					size="thin"
					icon="copy"
					backgroundColor={colors.accent}
					disabled={true}
					onPress={() => {/* Phase 21 */}}
				/>
			</View>

			{/* 5. Proposed Revision block — conditional */}
			{electionDetails.proposed && (
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold">{t("proposedRevisionHeader")}</ThemedText>

					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
						<ThemedText>#{proposed!.proposed.revision}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
						<ThemedText>{proposed!.proposed.tags.join(", ")}</ThemedText>
					</View>

					<ThemedText type="defaultSemiBold" style={styles.sectionLabel}>{t("timeline")}</ThemedText>
					<ElectionTimelineList timeline={proposed!.proposed.timeline} />

					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
						<ThemedText>{proposed!.proposed.keyholderThreshold} of {proposed!.proposed.keyholders.length}</ThemedText>
					</View>

					{/* Signing rows — one per proposed keyholder */}
					{proposed!.proposed.keyholders.map((holder, idx) => {
						// EUI-04 (D-02): navigation-only task object; real signing is Phase 21.
						// Mirrors TasksScreen.tsx:129 navigate("SignatureTask", { task }) shape.
						const signatureTask: ElectionRevisionSignatureTask = {
							type: "signature",
							signatureType: "election-revision",
							// network and userId are not available on this screen; Phase 21 will
							// source the real task from the task queue (navigation-only this phase).
							network: { hash: "", name: election.authorityId, primaryAuthorityDomainName: election.authorityId, relays: [] },
							userId: "",
							election: {
								proposed: {
									election: {
										id: election.id,
										authorityId: election.authorityId,
										title: election.title,
										type: election.type,
										date: election.date,
										revisionDeadline: election.revisionDeadline,
										ballotDeadline: election.ballotDeadline,
									},
									revision: proposed!.proposed,
								},
								signers: [],
							},
						};
						return (
							<View key={holder.name ?? `proposed-holder-${idx}`} style={styles.signingRow}>
								<ThemedText type="defaultSemiBold" style={styles.holderName}>{holder.name}</ThemedText>
								<View style={styles.signingPills}>
									<CustomButton
										title={t("signRevision")}
										size="thin"
										icon="signature"
										backgroundColor={colors.accent}
										onPress={() => navigation.navigate("SignatureTask", { task: signatureTask })}
									/>
									<CustomButton
										title={t("shareRevision")}
										size="thin"
										icon="share-nodes"
										backgroundColor={colors.warning}
										onPress={() => handleShare(election, proposed, current)}
									/>
								</View>
							</View>
						);
					})}

					{/* ADJUST REVISION → EditElectionRevision */}
					<CustomButton
						title={t("adjustRevision")}
						size="thin"
						icon="pencil"
						backgroundColor={colors.accent}
						onPress={() => navigation.navigate("EditElectionRevision", { electionEngine })}
					/>
				</View>
			)}

			{/* 6. Ballot Templates section */}
			<View style={styles.section}>
				<ThemedText type="title">{t("ballotTemplates")}</ThemedText>
				{ballots.length > 0 ? (
					ballots.map((ballot) => (
						<InfoCard
							key={ballot.id}
							title={ballot.authorityId || t("ballotTemplate")}
							subtitle={t("questionsLabel") + ": —"}
							icon="chevron-right"
							onPress={() =>
								navigation.navigate("EditBallot", {
									electionId: election.id,
									electionTitle: election.title,
									electionDate: formatDate(election.revisionDeadline),
									ballotId: ballot.id,
									electionEngine,
								} as any)
							}
						/>
					))
				) : (
					<>
						<ThemedText type="small">{t("noBallotYet")}</ThemedText>
						<CustomButton
							title={t("createBallotTemplate")}
							size="thin"
							icon="plus"
							backgroundColor={colors.accent}
							onPress={() =>
								navigation.navigate("CreateBallot", {
									electionId: election.id,
									electionTitle: election.title,
									electionDate: formatDate(election.revisionDeadline),
									electionEngine,
								} as any)
							}
						/>
					</>
				)}
			</View>

			{/* 7. More section (collapsible) + filter-authorities input */}
			<View style={styles.section}>
				<ChipButton label={t("more")} onPress={() => setMoreOpen((v) => !v)} />
				{moreOpen && (
					<CustomTextInput
						placeholder={t("filterAuthoritiesField")}
					/>
				)}
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginVertical: 2,
	},
	sectionLabel: {
		marginTop: 8,
		marginBottom: 2,
	},
	signingRow: {
		marginVertical: 6,
	},
	holderName: {
		marginBottom: 4,
	},
	signingPills: {
		flexDirection: "row",
		gap: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
