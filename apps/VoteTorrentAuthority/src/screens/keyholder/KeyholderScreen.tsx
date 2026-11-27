import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { DKG_ROUND_DEADLINE_MS } from "@votetorrent/vote-core";
import type { IElectionEngine, InviteStatus, KeyholderDkgStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { resolveKeyholderKeyVault } from "../../engines/keyholder-vault";
import { driveKeyholderDkg, keyholderDkgRowState, type KeyholderDkgRowState } from "./keyholder-dkg-driver";
import { KeyholderDkgStatusRow } from "./components/KeyholderDkgStatusRow";
import { KeyholderDkgOverdueNotice } from "./components/KeyholderDkgOverdueNotice";
import { overdueKeyholderLabels } from "./keyholder-dkg-overdue";
import { KEYHOLDER_INVITE_STATE_META, keyholderInviteState } from "./keyholder-invite-status";

type KeyholderParams = {
	keyholder: InviteStatus<SentKeyholderInvite>;
	electionEngine: IElectionEngine;
};

export function KeyholderScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { keyholder: routeKeyholder, electionEngine } = useRoute().params as KeyholderParams;
	const { getEngine } = useApp();
	// UAT 62 M: the route param is a snapshot taken when the card was tapped. Each focus re-reads
	// the election and swaps in the same-named keyholder from the engine, so an accept (or decline)
	// that happened since shows here without leaving the screen.
	const [keyholder, setKeyholder] = useState<InviteStatus<SentKeyholderInvite>>(routeKeyholder);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("keyholder") });
	}, [navigation, t]);

	// INV-03: navigate to KeyholderInvitation in send mode, passing the engine and keyholder
	// so the send screen can call electionEngine.inviteKeyholder (un-gated by 21-05).
	const onInvite = () => {
		navigation.navigate("KeyholderInvitation", {
			mode: "send",
			electionEngine,
			keyholder,
		});
	};

	const seedInvite = keyholder.invite;

	// D-19 (62-26): the keyholder DKG round driver runs pull-only, on screen focus — which
	// covers "open" too, since useFocusEffect fires on first focus. No timer, no interval.
	const [dkgRowState, setDkgRowState] = useState<KeyholderDkgRowState | null>("loading");
	const [dkgErrorMessage, setDkgErrorMessage] = useState<string>("");
	// The latest outcome's status and the fresh keyholder list feed the advisory overdue notice (D-19
	// round-deadline ruling). Both are replaced on every focus; the notice never acts, it only names.
	const [dkgStatus, setDkgStatus] = useState<KeyholderDkgStatus | null>(null);
	const [dkgKeyholders, setDkgKeyholders] = useState<ReadonlyArray<InviteStatus<SentKeyholderInvite>>>([]);
	const inFlight = useRef(false);
	// Results apply while the screen is mounted, not only while the focus that started the drive is
	// still current: a blur and re-focus mid-drive must not strand the row on "loading".
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	// Read `t` through a ref so a language change does not re-run the focus effect.
	const tRef = useRef(t);
	tRef.current = t;

	useFocusEffect(
		useCallback(() => {
			if (!inFlight.current) {
				inFlight.current = true;
				(async () => {
					try {
						const details = await electionEngine.getElectionDetails();
						const electionId = details.election.id;
						const fresh = details.current?.keyholders?.find((k) => k.invite?.name === routeKeyholder.invite?.name);
						const current = fresh ?? routeKeyholder;
						if (mounted.current && fresh) setKeyholder(fresh);
						const outcome = await driveKeyholderDkg(
							{ getEngine, vault: resolveKeyholderKeyVault() },
							electionId,
							current.result?.invokedId
						);
						if (!mounted.current) return;
						// Per this screen's own contract: when the status is unknown (null) AND an
						// error occurred, render no row at all — the InlineError alone carries the
						// message. Any other outcome (including a null status with NO error, which
						// never happens, and every successful read) renders the row.
						setDkgStatus(outcome.status);
						setDkgKeyholders(details.current?.keyholders ?? []);
						setDkgRowState(outcome.status === null && outcome.error ? null : keyholderDkgRowState(outcome.status));
						if (outcome.error) {
							const tt = tRef.current;
							setDkgErrorMessage(
								outcome.error.authDenied
									? tt("deviceSigningErrorGeneric")
									: outcome.error.code === "peer-unavailable"
										? tt("peerWriteUnavailable")
										: tt("keyholderDkgError")
							);
						} else {
							setDkgErrorMessage("");
						}
					} catch (err) {
						// The election read (or the drive itself) rejected: leave "loading" and say so in
						// catalog copy. Only the error name is logged; the message can carry engine text.
						console.warn("KeyholderScreen: DKG status read failed", err instanceof Error ? err.name : "unknown");
						if (mounted.current) {
							setDkgRowState(null);
							setDkgStatus(null);
							setDkgErrorMessage(tRef.current("keyholderDkgLoadError"));
						}
					} finally {
						inFlight.current = false;
					}
				})();
			}
		}, [electionEngine, getEngine, routeKeyholder])
	);

	const overdueLabels = overdueKeyholderLabels(dkgStatus, dkgKeyholders, t("dkgOverdueUnnamed"));

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText>{seedInvite?.name ?? t("keyholderUnnamed")}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderStatusLabel")}: </ThemedText>
					<ThemedText testID="keyholder-invite-status">{t(KEYHOLDER_INVITE_STATE_META[keyholderInviteState(keyholder)].labelKey)}</ThemedText>
				</View>
				{keyholderInviteState(keyholder) === "accept-again" ? (
					<ThemedText testID="keyholder-reaccept-officer-note">{t("keyholderReacceptOfficerNote")}</ThemedText>
				) : null}
				{dkgRowState !== null ? <KeyholderDkgStatusRow state={dkgRowState} /> : null}
				<KeyholderDkgOverdueNotice labels={overdueLabels} hours={DKG_ROUND_DEADLINE_MS / 3600000} />
				<InlineError message={dkgErrorMessage} />
			</View>
			<View style={styles.section}>
				<CustomButton
					title={t("invite")}
					icon="paper-plane"
					backgroundColor={colors.accent}
					size="thin"
					onPress={onInvite}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default KeyholderScreen;
