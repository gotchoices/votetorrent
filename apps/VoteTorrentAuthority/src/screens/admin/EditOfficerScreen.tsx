import { ExtendedTheme, useFocusEffect, useTheme } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View, Switch } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { adminChangeEffectiveAt, officerSelectionFromInvitee } from "@votetorrent/vote-core";
import type {
	AcceptedOfficerInvitee,
	AdminDetails,
	Authority,
	IAuthorityEngine,
	IInvitationEngine,
	INetworkEngine,
	IUserEngine,
	Officer,
	OfficerSelection,
	PendingAdminChange,
	Scope,
	ThresholdPolicy,
	User,
} from "@votetorrent/vote-core";
import { OFFICER_SCOPE_CODES, scopeLabel } from "../../utils/scopeLabel";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { useSettings } from "../../providers/SettingsProvider";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InlineError } from "../../components/InlineError";
import { AdminChangeConfirmCard } from "../../components/AdminChangeConfirmCard";
import { PendingAdminChangeCard } from "../../components/PendingAdminChangeCard";
import { globalStyles } from "../../theme/styles";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { errorCopy } from "../../utils/errorCopy";
import { adminChangeErrorKey, promotionWasRefused } from "../../utils/adminChangeErrors";
import { isAdminChangeConfirmStale } from "../../utils/displayUtils";

/**
 * The change the confirm card describes: computed once on the first Save or Remove tap and signed
 * exactly as stored (shown == signed, D-04).
 */
type ConfirmingChange = {
	effectiveAt: string;
	officers: OfficerSelection[];
	thresholdPolicies: ThresholdPolicy[];
};

/**
 * The one place this screen takes an effective time: five minutes from now, from the shared vote-core
 * rule (D-06). Called on the first tap and again only when a confirm card went stale.
 */
function freshEffectiveAt(): string {
	return adminChangeEffectiveAt(Date.now());
}

/**
 * The base of every change: the CURRENT administration's officers and policies. A proposal that
 * was refused, cancelled or went stale is never a base (F4).
 */
function currentRoster(details: AdminDetails): { officers: OfficerSelection[]; thresholdPolicies: ThresholdPolicy[] } {
	return {
		officers: details.admin.officers.map((o: Officer): OfficerSelection => ({ existing: o })),
		thresholdPolicies: details.admin.thresholdPolicies,
	};
}

export default function EditOfficerScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { showHelpIcons } = useSettings();
	const { authority, officerId } = useRoute().params as {
		authority: Authority;
		officerId?: string;
	};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const [title, setTitle] = useState("");
	const [scopes, setScopes] = useState<Scope[]>([]);
	const [user, setUser] = useState<User | null>(null);
	const [userEngine, setUserEngine] = useState<IUserEngine | null>(null);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isSaving, setIsSaving] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const [pending, setPending] = useState<PendingAdminChange | undefined>(undefined);
	const [invitees, setInvitees] = useState<AcceptedOfficerInvitee[]>([]);
	const [selectedInvitee, setSelectedInvitee] = useState<AcceptedOfficerInvitee | undefined>(undefined);
	const [confirming, setConfirming] = useState<ConfirmingChange | undefined>(undefined);
	const [confirmNotice, setConfirmNotice] = useState("");
	const seededRef = useRef(false);
	const confirmInFlightRef = useRef(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Editing an existing administrator (vs. adding a new one). Drives the
	// frame-35 vs frame-12 layout: edit shows the User card + REMOVE; add shows
	// the accepted-invitee chooser.
	const isEditing = !!officerId;
	// While the confirm card shows, every input is locked so the card can never describe a change
	// the screen no longer shows (D-04).
	const locked = confirming !== undefined;

	const openAuthorityEngine = useCallback(async (): Promise<IAuthorityEngine> => {
		const networkEngine = await getEngine<INetworkEngine>("network");
		return (await networkEngine.openAuthority(authority.id)) as IAuthorityEngine;
	}, [getEngine, authority.id]);

	// Re-read on every focus (returning from Send Invitation or UserDetails must show a new pending
	// change and new accepted invitees). The form is seeded on the FIRST successful load only, so a
	// later focus never discards what the officer has already entered.
	const load = useCallback(async () => {
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			const authorityEngine = await networkEngine.openAuthority(authority.id);
			const details = await authorityEngine.getAdminDetails();
			setPending(details.pending);
			if (!isEditing) {
				const invitationEngine = await getEngine<IInvitationEngine>("invitations");
				const accepted = await invitationEngine.getAcceptedOfficerInvitees();
				// The list is network-wide; drop people who are already officers here (R-25).
				const officerIds = new Set(details.admin.officers.map((o) => o.userId));
				setInvitees(accepted.filter((i) => !officerIds.has(i.userId)));
			}
			if (!seededRef.current) {
				const foundOfficer = isEditing ? details.admin.officers.find((o) => o.userId === officerId) : undefined;
				if (foundOfficer) {
					// Officer has no `name` field (vote-core/authority/models.ts).
					// Source the display name from the User join via networkEngine.getUser()
					// (Phase 7 D-15 opportunistic fix; preferred Option A from 08-04 plan).
					try {
						const ue = await networkEngine.getUser(foundOfficer.userId);
						const u = await ue?.getSummary();
						setUserEngine(ue ?? null);
						setUser(u ?? null);
					} catch (userError) {
						console.warn("Error loading user for officer:", userError);
					}
					setTitle(foundOfficer.title);
					setScopes(foundOfficer.scopes);
				}
				seededRef.current = true;
			}
		} catch (error) {
			console.warn("Error loading officer:", error);
			setErrorMessage(errorCopy(error, t, "read"));
		}
		// The form state is deliberately absent: typing must never trigger a reload.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [getEngine, authority.id, officerId, isEditing]);

	useFocusEffect(
		useCallback(() => {
			load();
		}, [load])
	);

	// One catch shape for starting and confirming a change (R-16). Coded refusals map to their
	// copy; nothing reads the error's own text.
	const handleChangeError = (err: unknown) => {
		setConfirming(undefined);
		setConfirmNotice("");
		const outcome = handleDeviceSigningError(err);
		if (outcome.handled) return;
		const key = adminChangeErrorKey(err);
		setErrorMessage(key ? t(key) : outcome.message ?? errorCopy(err, t, "write"));
	};

	// First tap of Save or Remove: re-read, refuse locally while a change is pending (D-08, before
	// any prompt), build the change from the current roster, and take its time ONCE (D-04, D-06).
	const beginChange = async (build: (roster: OfficerSelection[]) => Promise<OfficerSelection[]> | OfficerSelection[]) => {
		setErrorMessage("");
		try {
			const authorityEngine = await openAuthorityEngine();
			const details = await authorityEngine.getAdminDetails();
			if (details.pending) {
				setPending(details.pending);
				setErrorMessage(t("adminChangePendingRefusal"));
				return;
			}
			const roster = currentRoster(details);
			const officers = await build(roster.officers);
			const effectiveAt = freshEffectiveAt();
			setConfirming({ effectiveAt, officers, thresholdPolicies: roster.thresholdPolicies });
			setConfirmNotice("");
		} catch (err) {
			handleChangeError(err);
		}
	};

	// ADM-01: REMOVE drops the officer from the current administration.
	const handleRemove = async () => {
		if (confirming || isRemoving) return;
		setIsRemoving(true);
		try {
			await beginChange((roster) => roster.filter((s) => s.existing?.userId !== officerId));
		} finally {
			setIsRemoving(false);
		}
	};
	// The header chip keeps one stable press handler that always runs the latest handleRemove.
	const removeRef = useRef(handleRemove);
	removeRef.current = handleRemove;
	const onRemovePress = useCallback(() => {
		removeRef.current();
	}, []);

	useEffect(() => {
		navigation.setOptions({
			headerRight: isEditing
				? () => (
						<ChipButton
							label={isRemoving ? `${t("remove")}…` : t("remove")}
							icon="trash"
							onPress={onRemovePress}
							disabled={isRemoving || confirming !== undefined}
						/>
					)
				: undefined,
		});
	}, [navigation, t, isEditing, onRemovePress, isRemoving, confirming]);

	const handleScopeToggle = (scope: Scope) => {
		if (confirming) return;
		setScopes((prev) => {
			if (prev.includes(scope)) {
				return prev.filter((id) => id !== scope);
			} else {
				return [...prev, scope];
			}
		});
	};

	const handleTitleChange = (text: string) => {
		if (locked) return;
		setTitle(text);
	};

	// ADM-01: SAVE edits an officer's title and permissions, or adds an accepted invitee.
	const handleSave = async () => {
		if (confirming || isSaving) return;
		setIsSaving(true);
		try {
			await beginChange(async (roster) => {
				if (isEditing) {
					return roster.map((s) =>
						s.existing && s.existing.userId === officerId ? { existing: { ...s.existing, title, scopes } } : s
					);
				}
				// D-12: only someone who accepted an administrator invitation, re-read at tap time, and
				// never someone who is already an officer. The selection is bound to their user id.
				const invitationEngine = await getEngine<IInvitationEngine>("invitations");
				const accepted = await invitationEngine.getAcceptedOfficerInvitees();
				const currentIds = new Set(roster.map((s) => s.existing?.userId));
				const fresh = accepted.filter((i) => !currentIds.has(i.userId));
				setInvitees(fresh);
				const found = fresh.find((i) => i.userId === selectedInvitee?.userId);
				if (!found) setSelectedInvitee(undefined);
				return [...roster, officerSelectionFromInvitee(found, authority.id, title, scopes)];
			});
		} finally {
			setIsSaving(false);
		}
	};

	// The card's Confirm: a stale card signs nothing and comes back with a fresh time (D-01, D-04);
	// otherwise the stored change is signed exactly as shown, on ONE engine instance.
	const confirmChange = async () => {
		if (!confirming || confirmInFlightRef.current) return;
		if (isAdminChangeConfirmStale(confirming.effectiveAt, Date.now())) {
			setConfirming({ ...confirming, effectiveAt: freshEffectiveAt() });
			setConfirmNotice(t("adminChangeConfirmTimeUpdated"));
			return;
		}
		confirmInFlightRef.current = true;
		setIsSaving(true);
		try {
			// openAuthority returns a fresh engine per call: the promotion outcome is read from the
			// same instance proposeAdmin ran on.
			const authorityEngine = await openAuthorityEngine();
			// Resolve the device user id for the signers array. The private key lives in the
			// hardware keystore and never enters JS; the engine computes the digest (D-03).
			const deviceUser = await getOrCreateDeviceUser(user?.name ?? "Authority Administrator");
			const sign = await createDeviceSigner(user?.name ?? "Authority Administrator");
			await authorityEngine.proposeAdmin(
				{
					proposed: {
						officers: confirming.officers,
						effectiveAt: confirming.effectiveAt,
						thresholdPolicies: confirming.thresholdPolicies,
					},
					signers: [deviceUser.id],
				},
				sign
			);
			if (promotionWasRefused(authorityEngine)) {
				setConfirming(undefined);
				setConfirmNotice("");
				setErrorMessage(t("adminChangeNotApplied"));
				await load();
				return;
			}
			navigation.goBack();
		} catch (err) {
			handleChangeError(err);
		} finally {
			confirmInFlightRef.current = false;
			setIsSaving(false);
		}
	};

	const backFromConfirm = () => {
		setConfirming(undefined);
		setConfirmNotice("");
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView keyboardShouldPersistTaps="handled" style={styles.container}>
				{pending ? (
					// Cancel lives on Proposed Administration and Authority details; never a second path here.
					<PendingAdminChangeCard pending={pending} canCancel={false} onCancel={() => undefined} />
				) : null}
				<View style={styles.section}>
					{isEditing ? (
						<InfoCard
							image={(user as any)?.image?.url ? { uri: (user as any).image.url } : undefined}
							additionalInfo={[
								{ label: t("user"), value: user?.name ?? officerId },
								{ label: t("sid"), value: officerId },
							]}
							icon="chevron-right"
							onPress={() =>
								user && userEngine && navigation.navigate("UserDetails", { user, userEngine })
							}
						/>
					) : (
						<View>
							<ThemedText type="defaultSemiBold">{t("adminChangeChooseInvitee")}</ThemedText>
							{invitees.map((invitee) => (
								<View key={invitee.slotCid} testID={"edit-officer-invitee-" + invitee.slotCid}>
									<InfoCard
										title={invitee.name}
										additionalInfo={[{ label: t("sid"), value: invitee.userId }]}
										icon={selectedInvitee?.userId === invitee.userId ? "circle-check" : "circle"}
										onPress={
											locked
												? undefined
												: () => {
														setSelectedInvitee(invitee);
													}
										}
									/>
								</View>
							))}
							{invitees.length === 0 ? (
								<ThemedText testID="edit-officer-no-invitees">{t("adminChangeNoAcceptedInvitees")}</ThemedText>
							) : null}
							{/* Init officers are gone, so this is the owner's way to invite a new officer. */}
							<CustomButton
								testID="edit-officer-send-invitation"
								title={t("sendInvitation")}
								icon="paper-plane"
								disabled={locked}
								onPress={() =>
									navigation.navigate("AdministratorInvitation", {
										mode: "send",
										authority,
										officerInit: { name: "", title },
									})
								}
							/>
						</View>
					)}
					<CustomTextInput
						title={t("title")}
						placeholder={t("officialTitle")}
						value={title}
						editable={!locked}
						onChangeText={handleTitleChange}
					/>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("permissions")}
					</ThemedText>
					{OFFICER_SCOPE_CODES.map((scope) => (
						<View key={scope} style={styles.scopeRow}>
							<View style={styles.scopeDescriptionContainer}>
								<ThemedText>{scopeLabel(scope, t)}</ThemedText>
								{showHelpIcons && (
									<FontAwesome6
										name="circle-info"
										size={16}
										color={colors.text}
										style={styles.scopeInfoIcon}
									/>
								)}
							</View>
							<Switch
								value={scopes.includes(scope as Scope)}
								onValueChange={() => handleScopeToggle(scope as Scope)}
								disabled={locked}
								trackColor={{ false: colors.accent, true: colors.primary }}
								thumbColor={colors.card}
							/>
						</View>
					))}
				</View>
			</ScrollView>

			<InlineError message={errorMessage} />
			<Footer>
				{confirming ? (
					<AdminChangeConfirmCard
						effectiveAt={confirming.effectiveAt}
						onConfirm={confirmChange}
						onBack={backFromConfirm}
						busy={isSaving}
						notice={confirmNotice}
					/>
				) : (
					<CustomButton
						title={isSaving ? `${t("save")}…` : t("save")}
						icon="floppy-disk"
						disabled={(isEditing ? !title : !selectedInvitee || !title) || isSaving || isRemoving}
						backgroundColor={colors.success}
						forceDarkText={true}
						onPress={handleSave}
					/>
				)}
			</Footer>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		marginBottom: 32,
	},
	scopeRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingVertical: 4,
	},
	scopeDescriptionContainer: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	scopeInfoIcon: {
		marginLeft: 8,
	},
});
const styles = { ...globalStyles, ...localStyles };
