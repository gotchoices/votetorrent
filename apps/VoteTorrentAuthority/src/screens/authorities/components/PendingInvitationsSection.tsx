import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import type { IAuthorityEngine, IInvitationEngine } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { InfoCard } from "../../../components/InfoCard";
import { InlineError } from "../../../components/InlineError";
import { CustomButton } from "../../../components/CustomButton";
import { useApp } from "../../../providers/AppProvider";
import { peerUnavailableMessage } from "../../../utils/peerUnavailableMessage";
import type { RootStackParamList } from "../../../navigation/types";

/**
 * PendingInvitationsSection: the officer invitations of this authority that are still awaiting an
 * answer. A row opens AuthorityDetail, where Cancel and Resend live.
 *
 * Never-log/never-show rule: a row shows the stored invitee name only (or the "(no name)" copy),
 * never a Cid; failures render fixed translated copy, never engine text. Logs only `error.name`.
 */
export interface PendingInvitationsSectionProps {
	authorityId: string;
	authorityEngine: IAuthorityEngine | null;
}

interface Row {
	cid: string;
	name?: string;
}

export function PendingInvitationsSection({ authorityId, authorityEngine }: PendingInvitationsSectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const tRef = useRef(t);
	tRef.current = t;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const getEngineRef = useRef(getEngine);
	getEngineRef.current = getEngine;

	const [rows, setRows] = useState<Row[] | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	const mounted = useRef(true);
	const loadSeq = useRef(0);
	// WR-R3-02: rows belong to the authority (and engine) they were read for. When either changes, the
	// previous rows and error are dropped in the same render, so a row can never pair the new
	// `authorityId` with the previous authority's slot. `subjectRef` lets an in-flight load from the
	// previous subject see that it is no longer current, even when the new engine is still null (no
	// new load has started to bump `loadSeq`).
	const [rowsSubject, setRowsSubject] = useState({ authorityId, authorityEngine });
	if (rowsSubject.authorityId !== authorityId || rowsSubject.authorityEngine !== authorityEngine) {
		setRowsSubject({ authorityId, authorityEngine });
		setRows(null);
		setErrorMessage("");
	}
	const subjectRef = useRef({ authorityId, authorityEngine });
	subjectRef.current = { authorityId, authorityEngine };

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		if (!authorityEngine) return;
		const seq = ++loadSeq.current;
		const loadAuthorityId = subjectRef.current.authorityId;
		const current = () =>
			mounted.current &&
			seq === loadSeq.current &&
			subjectRef.current.authorityEngine === authorityEngine &&
			subjectRef.current.authorityId === loadAuthorityId;
		try {
			const cids = await authorityEngine.getPendingInviteCids();
			const list: Row[] = [];
			if (cids.length > 0) {
				let invitations: IInvitationEngine | undefined;
				try {
					invitations = await getEngineRef.current<IInvitationEngine>("invitations");
				} catch {
					invitations = undefined;
				}
				for (const cid of cids) {
					let name: string | undefined;
					try {
						const status = await invitations?.getOfficerInvite(cid);
						name = status?.invite?.name || undefined;
					} catch {
						name = undefined;
					}
					list.push({ cid, name });
				}
			}
			if (!current()) return;
			setErrorMessage("");
			setRows(list);
		} catch (err) {
			if (!current()) return;
			console.warn("pendingInvitations-load failed", err instanceof Error ? err.name : "unknown");
			setRows(null);
			setErrorMessage(peerUnavailableMessage(err, tRef.current, "read") ?? tRef.current("pendingInvitationsLoadError"));
		}
	}, [authorityEngine]);

	useFocusEffect(
		useCallback(() => {
			void load();
		}, [load]),
	);

	return (
		<View testID="pending-invitations" style={localStyles.container}>
			<ThemedText type="defaultSemiBold">{t("pendingInvitationsHeading")}</ThemedText>
			{errorMessage ? (
				<View>
					<InlineError message={errorMessage} />
					<CustomButton
						title={t("pendingInvitationsRetry")}
						backgroundColor={colors.accent}
						size="thin"
						testID="pending-invitations-retry"
						onPress={() => {
							void load();
						}}
					/>
				</View>
			) : rows === null ? (
				<View testID="pending-invitations-loading" />
			) : rows.length === 0 ? (
				<ThemedText type="default">{t("pendingInvitationsEmpty")}</ThemedText>
			) : (
				rows.map((row) => (
					<View key={row.cid} testID={`pending-invitation-${row.cid}`} style={localStyles.row}>
						<InfoCard
							title={row.name ?? t("keyholderUnnamed")}
							subtitle={t("sent")}
							icon="chevron-right"
							onPress={() => navigation.navigate("AuthorityDetail", { authorityId, slotCid: row.cid })}
						/>
					</View>
				))
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	container: { gap: 8, marginTop: 12 },
	row: {},
});
