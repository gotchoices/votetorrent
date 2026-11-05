import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";
import { PeerReadUnavailableNotice } from "../../components/PeerReadUnavailableNotice";
import { classifyPeerReadFailure } from "../../engines/peer-read-unavailable";
import type {
	Authority,
	IAuthorityEngine,
	INetworkEngine,
	AdminDetails,
	User,
	Officer,
} from "@votetorrent/vote-core";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { CustomButton } from "../../components/CustomButton";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useApp } from "../../providers/AppProvider";
import { AuthorizationSection } from "../../components/AuthorizationSection";
import { InfoCard } from "../../components/InfoCard";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";
import { formatDate } from "../../utils/displayUtils";
import { OfficerCard } from "./components/OfficerCard";
import { PendingInvitationsSection } from "./components/PendingInvitationsSection";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";

/** Shape the (forthcoming) real authority engine will provide for invited authorities. */
type InvitedAuthority = { name: string; status: "sent" | "unsent" };

export default function AuthorityDetailsScreen() {
	const { t } = useTranslation();
	// Effects read the latest t without re-running when its identity changes.
	const tRef = useRef(t);
	tRef.current = t;
	const keyboardInset = useKeyboardInset();
	const { colors } = useTheme() as ExtendedTheme;
	const { authority } = useRoute().params as { authority: Authority };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [authorityEngine, setAuthorityEngine] = useState<IAuthorityEngine | null>(null);
	const [pinned, setPinned] = useState(false);
	const [adminDetails, setAdminDetails] = useState<AdminDetails | null>(null);
	const [officerUsers, setOfficerUsers] = useState<Map<string, User>>(new Map());
	const [officers, setOfficers] = useState<Officer[]>([]);
	const [inviteSearch, setInviteSearch] = useState("");
	const [invitedAuthorities, setInvitedAuthorities] = useState<InvitedAuthority[]>([]);
	const [errorMessage, setErrorMessage] = useState("");
	// Gap 7: a read that could not reach the other devices. The notice variant is derived at render:
	// 'stale' while the administration this device last read is still shown, 'unavailable' when
	// nothing has been read yet. Never rendered as absence ("N/A", missing officers).
	const [peerUnavailable, setPeerUnavailable] = useState(false);
	// Try Again bumps this to re-run getAuthorityData.
	const [reloadNonce, setReloadNonce] = useState(0);
	// Try Again after a failed engine open re-runs loadEngines.
	const [engineNonce, setEngineNonce] = useState(0);
	// A stale navigation: the authority is not on the active network (62-91 openAuthority code
	// 'authority-not-found'). Shown as a translated state; never reads pins or administration.
	const [notFound, setNotFound] = useState(false);
	// REVIEW/IN-05: everything kept from a read (engine, pin state, administration, officers, invited
	// list, the peer notice) belongs to the authority it was read for. When the route moves to a
	// different authority the previous one's reads are dropped in the same render, so the
	// last-read fallback of a peer failure can never show A's data under B. The network engine is
	// per network, not per authority, and is kept.
	const [readSubjectId, setReadSubjectId] = useState(authority.id);
	if (readSubjectId !== authority.id) {
		setReadSubjectId(authority.id);
		setAuthorityEngine(null);
		setPinned(false);
		setAdminDetails(null);
		setOfficers([]);
		setOfficerUsers(new Map());
		setInvitedAuthorities([]);
		setPeerUnavailable(false);
		setNotFound(false);
		setErrorMessage("");
	}
	// WR-02: sequence number of the latest getAuthorityData run; older runs may not write.
	const authorityReadSeqRef = useRef(0);
	const officerUsersRef = useRef(officerUsers);
	officerUsersRef.current = officerUsers;

	const handlePinToggle = async () => {
		setErrorMessage("");
		try {
			if (pinned) {
				await networkEngine?.unpinAuthority(authority.id);
			} else {
				await networkEngine?.pinAuthority(authority);
			}
			setPinned(!pinned);
		} catch (error) {
			console.warn("Error toggling authority pin:", error);
			setErrorMessage(tRef.current("authorityPinFailed"));
		}
	};

	useEffect(() => {
		// WR-R3-01: an open that lands after the route moved to another authority (or after Try Again
		// started a newer open) must not write: its engine belongs to the previous subject.
		let cancelled = false;
		async function loadEngines() {
			setErrorMessage("");
			setNotFound(false);
			try {
				const engine = await getEngine("network");
				if (cancelled) return;
				setNetworkEngine(engine as INetworkEngine);
				if (engine) {
					const authorityEngine = await (engine as INetworkEngine).openAuthority(authority.id);
					if (cancelled) return;
					setAuthorityEngine(authorityEngine);
				}
			} catch (error) {
				if (cancelled) return;
				const code = (error as { code?: unknown } | null)?.code;
				const message = (error as { message?: unknown } | null)?.message;
				if (code === "authority-not-found" || message === "Authority not found") {
					setNotFound(true);
					return;
				}
				const peerFailure = classifyPeerReadFailure(error);
				if (peerFailure) {
					console.warn("[authority-details] peer read unavailable:", peerFailure.reason);
					setPeerUnavailable(true);
					return;
				}
				console.warn("Error loading engines:", error);
				setErrorMessage(tRef.current("authorityDetailsLoadFailed"));
			}
		}
		loadEngines();
		return () => {
			cancelled = true;
		};
	}, [getEngine, authority.id, engineNonce]);

	useEffect(() => {
		async function getAuthorityData() {
			// WR-02: a cohort-unreachable read can take a long time to fail while Try Again starts
			// another. Only the latest read may write, so a slow earlier failure cannot re-raise the
			// notice over fresh data, and a slow earlier success cannot overwrite a newer one.
			const seq = ++authorityReadSeqRef.current;
			const isLatest = () => seq === authorityReadSeqRef.current;
			if (notFound) {
				setAdminDetails(null);
				return;
			}
			if (!networkEngine || !authorityEngine) {
				setPinned(false);
				setAdminDetails(null);
				return;
			}
			try {
				const pinnedAuthorities = await networkEngine.getPinnedAuthorities();
				if (!isLatest()) return;
				setPinned(pinnedAuthorities.some((a: Authority) => a.id === authority.id));
				const details = await authorityEngine.getAdminDetails();
				if (!isLatest()) return;
				setAdminDetails(details);
				setPeerUnavailable(false);
			} catch (error) {
				if (!isLatest()) return;
				const peerFailure = classifyPeerReadFailure(error);
				if (peerFailure) {
					// Gap 7 (D-23/D-39): the network could not answer, which is not the same as the
					// administration being absent. Keep adminDetails / pinned exactly as they were and
					// never surface the engine message (it names block ids). Reason token only.
					console.warn("[authority-details] peer read unavailable:", peerFailure.reason);
					setPeerUnavailable(true);
					return;
				}
				console.warn("Error checking pinned status:", error);
				setPinned(false);
				setAdminDetails(null);
				setErrorMessage(tRef.current("authorityDetailsLoadFailed"));
			}
		}
		getAuthorityData();
	}, [networkEngine, authorityEngine, authority.id, reloadNonce, notFound]);

	useEffect(() => {
		let cancelled = false;
		async function getUsers() {
			if (!networkEngine || !adminDetails) {
				setOfficers([]);
				setOfficerUsers(new Map());
				return;
			}

			try {
				// Store the officers list
				setOfficers(adminDetails.admin.officers);

				// Create mapping of userId to User object
				const userMap = new Map<string, User>();

				// Get all userIds we need to fetch (both current and proposed existing officers)
				const userIds = new Set<string>();

				// Add current officers
				adminDetails.admin.officers.forEach((admin) => {
					userIds.add(admin.userId);
				});

				// Add proposed existing administrators
				if (adminDetails.proposed?.proposed.officers) {
					adminDetails.proposed.proposed.officers.forEach((officerSelection) => {
						if (officerSelection.existing) {
							userIds.add(officerSelection.existing.userId);
						}
					});
				}

				// Fetch all users. A user read that could not reach the other devices keeps the
				// summary this device last read for that user (gap 7) instead of failing the list.
				let peerFailureReason: string | undefined;
				const userEnginePromises = Array.from(userIds).map(async (userId) => {
					try {
						const userEngine = await networkEngine.getUser(userId);
						if (userEngine) {
							const details = await userEngine.getSummary();
							if (details) {
								userMap.set(userId, details);
							}
						}
					} catch (error) {
						const peerFailure = classifyPeerReadFailure(error);
						if (!peerFailure) throw error;
						peerFailureReason = peerFailure.reason;
						const lastRead = officerUsersRef.current.get(userId);
						if (lastRead) userMap.set(userId, lastRead);
					}
				});
				await Promise.all(userEnginePromises);
				if (cancelled) return;
				setOfficerUsers(userMap);
				if (peerFailureReason) {
					console.warn("[authority-details] peer read unavailable:", peerFailureReason);
					setPeerUnavailable(true);
				}
			} catch (error) {
				if (cancelled) return;
				console.warn("Error fetching users:", error);
				setOfficers([]);
				setOfficerUsers(new Map());
				setErrorMessage(tRef.current("officersLoadFailed"));
			}
		}
		getUsers();
		return () => {
			cancelled = true;
		};
	}, [networkEngine, adminDetails]);

	useEffect(() => {
		// Invited authorities are supplied by the real authority engine (to be
		// implemented). Bind defensively so this UI is ready without adding mock
		// data — the section renders empty until the engine provides the list.
		let cancelled = false;
		async function loadInvited() {
			const fn = (authorityEngine as any)?.getInvitedAuthorities;
			if (typeof fn !== "function") return;
			try {
				const invited = (await fn.call(authorityEngine)) ?? [];
				if (cancelled) return;
				setInvitedAuthorities(invited);
			} catch (error) {
				if (cancelled) return;
				console.warn("Error loading invited authorities:", error);
				setErrorMessage(tRef.current("invitedAuthoritiesLoadFailed"));
			}
		}
		loadInvited();
		return () => {
			cancelled = true;
		};
	}, [authorityEngine]);

	useEffect(() => {
		navigation.setOptions({
			// No pin chip for an authority that is not on this network: nothing to pin.
			headerRight: notFound
				? undefined
				: () => (
						<ChipButton
							label={pinned ? t("unpin") : t("pin")}
							icon={pinned ? "thumbtack-slash" : "thumbtack"}
							onPress={handlePinToggle}
						/>
					),
		});
	}, [pinned, notFound, navigation, t, handlePinToggle]);

	// WR-R3-03: the network engine itself failed to open. Without this block the screen returned
	// null and neither the error copy nor the Try Again (which re-runs loadEngines) was reachable.
	if (authority && !networkEngine && (errorMessage || peerUnavailable)) {
		const retryEngines = () => {
			setReloadNonce((n) => n + 1);
			setEngineNonce((n) => n + 1);
		};
		return (
			<ScrollView
				testID="authority-details-engine-failed"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: 32 + keyboardInset }}
			>
				<InlineError message={errorMessage} />
				{peerUnavailable ? (
					<PeerReadUnavailableNotice variant="unavailable" onRetry={retryEngines} />
				) : (
					<CustomButton
						title={t("peerReadUnavailableRetry")}
						icon="rotate-right"
						size="tall"
						testID="authority-details-engine-retry"
						onPress={retryEngines}
					/>
				)}
			</ScrollView>
		);
	}

	if (!authority || !networkEngine) {
		return null;
	}

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 + keyboardInset }}>
			<InlineError message={errorMessage} />
			<View style={styles.section}>
				{/* The 200x200 box renders only when there is an image; without one it was a large
				    blank space above the name. */}
				{authority.imageRef?.url ? (
					<View testID="authority-details-image" style={styles.imageContainer}>
						<Image source={{ uri: authority.imageRef.url }} style={styles.authorityImage} />
					</View>
				) : null}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail" style={styles.detailValue}>
						{authority.name}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("domainName")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail" style={styles.detailValue}>
						{authority.domainName}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("cid")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.detailValue}>
						{authority.id}
					</ThemedText>
				</View>
				{authority.imageRef?.url ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("imageUrl")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail" style={styles.detailValue}>
							{authority.imageRef.url}
						</ThemedText>
					</View>
				) : null}
				{(authority as any).address ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("address")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.detailValue}>
							{(authority as any).address}
						</ThemedText>
					</View>
				) : null}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
					<ThemedText>[{t("valid")}]</ThemedText>
				</View>
				{notFound ? (
					<View
						testID="authority-not-on-network"
						accessibilityRole="alert"
						style={[styles.notFoundBox, { borderColor: colors.warning, backgroundColor: colors.card }]}
					>
						<ThemedText type="defaultSemiBold">{t("authorityNotOnNetworkTitle")}</ThemedText>
						<ThemedText type="small">{t("authorityNotOnNetworkBody")}</ThemedText>
					</View>
				) : (
					<CustomButton
						title={t("reviseAuthority")}
						icon="pencil"
						size="thin"
						backgroundColor={colors.accent}
						onPress={() => navigation.navigate("NetworkRevision", { networkId: authority.id })}
					/>
				)}
			</View>

			{notFound ? null : (
			<View style={styles.section}>
				<ThemedText type="title">{t("administration")}</ThemedText>

				{peerUnavailable ? (
					<PeerReadUnavailableNotice
						variant={adminDetails ? "stale" : "unavailable"}
						onRetry={() => {
							setReloadNonce((n) => n + 1);
							setEngineNonce((n) => n + 1);
						}}
					/>
				) : null}

				{/* Gap 7: an administration that could not be read is not shown as one with no date
				    and no officers. The notice above stands in for the Effective line and the cards. */}
				{peerUnavailable && !adminDetails ? null : (
					<>
						{(adminDetails?.admin as any)?.priorId ? (
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("priorCid")}: </ThemedText>
								<ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.detailValue}>
									{(adminDetails?.admin as any).priorId}
								</ThemedText>
							</View>
						) : null}

						{(() => {
							const adminSignatures = (adminDetails?.admin as any)?.signatures as
								| Array<{ name?: string; signerKey?: string; valid?: boolean }>
								| undefined;
							if (!adminSignatures || adminSignatures.length === 0) return null;
							return (
								<View>
									<View style={styles.detail}>
										<ThemedText type="defaultSemiBold">{t("handoffSignatures")}: </ThemedText>
									</View>
									<View style={styles.subDetails}>
										{adminSignatures.map((signature, idx) => (
											<View key={signature.signerKey ?? idx} style={styles.detail}>
												<ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.detailValue}>
													{signature.name ? `${signature.name} ` : ""}[{signature.signerKey}]
												</ThemedText>
												<ThemedText> ({t("valid")})</ThemedText>
											</View>
										))}
									</View>
								</View>
							);
						})()}
						{adminDetails?.admin.id ? (
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("cid")}: </ThemedText>
								<ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.detailValue}>
									{adminDetails.admin.id}
								</ThemedText>
							</View>
						) : null}
						{/* UAT 62: effectiveAt is when the administration STARTS, not an expiry. */}
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("effective")}: </ThemedText>
							<ThemedText>{formatDate(adminDetails?.admin.effectiveAt)}</ThemedText>
						</View>

						{officers.map((officer) => {
							const user = officerUsers.get(officer.userId);
							// Figma frame 7: compact card (image · name · role · CID) + chevron.
							return (
								<InfoCard
									key={officer.userId}
									image={(user as any)?.image?.url ? { uri: (user as any).image.url } : undefined}
									title={user?.name || officer.userId}
									subtitle={officer.title}
									additionalInfo={[{ label: t("cid"), value: officer.userId }]}
									icon="chevron-right"
									onPress={() =>
										navigation.navigate("OfficerDetails", {
											officer: officer,
											userName: user?.name,
											authority: authority,
										})
									}
								/>
							);
						})}

						{!adminDetails?.proposed && (
							<CustomButton
								title={t("reviseAdministration")}
								icon="pencil"
								size="thin"
								onPress={() =>
									navigation.navigate("ProposedAdministration", {
										authorityId: authority.id,
									})
								}
							/>
						)}
					</>
				)}

				<PendingInvitationsSection authorityId={authority.id} authorityEngine={authorityEngine} />
			</View>
			)}

			{adminDetails?.proposed && (
				<View>
					<View style={styles.section}>
						<ThemedText type="title">{t("proposedAdministration")}</ThemedText>
						{/* UAT 62: no CID row here. It showed the CURRENT administration's id, and a
						    proposal (Proposal<AdminInit>) carries no id of its own until promoted. */}
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("effective")}: </ThemedText>
							<ThemedText>{formatDate(adminDetails.proposed.proposed.effectiveAt)}</ThemedText>
						</View>
						<ThemedText type="defaultSemiBold" style={styles.administratorsHeading}>
							{t("administrators")}
						</ThemedText>
						{adminDetails.proposed.proposed.officers.map((officerSelection) => {
							const officer: Officer = officerSelection.existing || {
								userId: "",
								authorityId: authority.id,
								title: officerSelection.init?.title || "",
								scopes: officerSelection.init?.scopes || [],
							};
							const user = officer.userId ? officerUsers.get(officer.userId) : undefined;
							const name = user?.name || officerSelection.init?.name || "";
							// Frame 14: accepted entries show "Accepted - CID: <cid>" in
							// green; pending invites show "Sent" in the warning tone.
							const status = officerSelection.existing
								? {
										label: `${t("accepted")} - ${t("cid")}: ${officer.userId}`,
										tone: "accepted" as const,
									}
								: { label: t("sent"), tone: "warning" as const };

							return (
								<OfficerCard
									key={officer.userId || officerSelection.init?.name}
									officer={officer}
									userName={name}
									image={user?.image?.url ? { uri: user.image.url } : undefined}
									inviteId={(officerSelection as any)?.inviteId}
									status={status}
									onInvite={
										officerSelection.existing || !officerSelection.init
											? undefined
											: () =>
													navigation.navigate("AdministratorInvitation", {
														mode: "send",
														authority,
														officerInit: {
															name: officerSelection.init!.name,
															title: officerSelection.init!.title,
														},
													})
									}
								/>
							);
						})}
					</View>

					<AuthorizationSection
						admin={adminDetails}
						signedOfficerIds={adminDetails.proposed.signers}
						onAdjustProposal={() =>
							navigation.navigate("ProposedAdministration", {
								authorityId: authority.id,
							})
						}
					/>
				</View>
			)}

			{/* Phase 47 plan 47-21 (D-08) — Registrants / Polling Devices / Authority
			    Peers entry rows. (i) Placed here because they are authority-owned
			    surfaces — polling devices and authority peers are authority-config,
			    not registrant data. (ii) The rows are NOT scope-gated: an officer
			    lacking 'vrg' or 'cap' reaches the destination screen read-only, with
			    that screen's own banner and its visible-but-disabled write controls
			    — the D-13 default pattern working as designed. (iii) The row is
			    navigation, not an access control — the schema's AdminSignature CHECK
			    on each ceremony is the enforcement boundary (T-47-04). No
			    officer-scope hook is added to this screen. */}
			<View style={styles.section} testID="authority-details-phase47-entries">
				<View testID="authority-details-registrants-entry">
					<InfoCard
						title={t("registrantListScreenTitle")}
						icon="chevron-right"
						onPress={() =>
							// Authority-wide roster — NO electionFilter. The election-filtered
							// variant is the same route reached from ElectionDetailsScreen
							// (D-07); a second roster route was deliberately not created.
							navigation.navigate("RegistrantsList", { authorityId: authority.id })
						}
					/>
				</View>
				{/* Phase 48 plan 48-21 (D-12) — Registration Requests entry row,
				    following its three siblings' ungated pattern deliberately: no
				    officer-scope hook, no conditional render, no disabled state. The
				    row is navigation, not access control — RegistrationInboxScreen owns
				    its own read-only banner and visible-but-disabled write controls. */}
				<View testID="authority-details-registration-requests-entry">
					<InfoCard
						title={t("registrationRequestScreenTitle")}
						icon="chevron-right"
						onPress={() => navigation.navigate("RegistrationInbox", { authorityId: authority.id })}
					/>
				</View>
				<View testID="authority-details-polling-devices-entry">
					<InfoCard
						title={t("pollingDeviceScreenTitle")}
						icon="chevron-right"
						onPress={() => navigation.navigate("PollingDevices", { authorityId: authority.id })}
					/>
				</View>
				<View testID="authority-details-authority-peers-entry">
					<InfoCard
						title={t("authorityPeerScreenTitle")}
						icon="chevron-right"
						onPress={() => navigation.navigate("AuthorityPeers", { authorityId: authority.id })}
					/>
				</View>
			</View>

			<View style={styles.section}>
				<View style={styles.invitedHeader}>
					<ThemedText type="title">{t("invitedAuthorities")}</ThemedText>
					<View style={styles.invitedAction}>
						<ChipButton
							label={t("inviteAuthority")}
							icon="circle-plus"
							onPress={() => navigation.navigate("AuthorityInvitation", { mode: "send" })}
						/>
					</View>
				</View>
				<ThemedText type="defaultSemiBold" style={styles.invitedNameLabel}>
					{t("name")}
				</ThemedText>
				<CustomTextInput
					placeholder={t("name")}
					value={inviteSearch}
					onChangeText={setInviteSearch}
				/>
				{invitedAuthorities.map((invited) => (
					<InfoCard
						key={invited.name}
						title={invited.name}
						subtitle={invited.status === "sent" ? t("sent") : t("unsent")}
						icon="chevron-right"
						onPress={() => {}}
					/>
				))}
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	imageContainer: {
		position: "relative",
		width: 200,
		height: 200,
		alignSelf: "center",
		marginVertical: 16,
	},
	authorityImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},
	detail: {
		flexDirection: "row",
	},
	// The value beside a "Label: " in a detail row. Yoga defaults flexShrink to 0, so without
	// this a one-line value measures at the full row width and the label pushes it past the
	// right edge — clipped, with numberOfLines/ellipsizeMode never engaging (a long CID ran off
	// a 360dp screen). Ids ellipsize in the middle so both the head and the suffix stay visible.
	detailValue: {
		flexShrink: 1,
	},
	subDetails: {
		marginLeft: 8,
	},
	administratorsHeading: {
		marginTop: 12,
		marginBottom: 4,
	},
	notFoundBox: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 12,
		marginTop: 8,
		marginBottom: 8,
		gap: 4,
	},
	invitedHeader: {
		marginBottom: 8,
	},
	invitedAction: {
		// 24px title + "INVITE AUTHORITY" chip don't fit on one row on a phone,
		// so the chip drops below the heading, right-aligned — mirroring the
		// proposed-administration "ADD ADMINISTRATOR" chip placement.
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 8,
	},
	invitedNameLabel: {
		marginTop: 8,
		marginBottom: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
