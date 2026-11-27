import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { globalStyles } from "../theme/styles";
// WR-18: the SHARED never-throw date formatter, imported rather than re-implemented.
// `registration-request-display.ts` is pure — React-free, theme-free, engine-free — so importing
// it here adds no dependency weight, and more importantly adds no FOURTH copy of "how a timestamp
// is shown to an officer". The other three timestamp surfaces in this phase (the inbox row, the
// approval summary, the rejected block) already route through it; this import is what stops this
// card from being the one place that shows a raw ISO-8601 string instead.
import { formatRequestTimestamp } from "../screens/registration/registration-request-display";

/**
 * TransportStatusCard — the Bulk Import / Sync screen's per-binding status card (D-01/D-11).
 *
 * This file exports two structurally different components:
 *
 * (a) `TransportStatusCard` — filesystem and REST. These are the two *provable* D-01 bindings:
 *     real transports whose sync outcome is a fact this app can observe and report. Their cards
 *     are state-driven — icon, color and copy all resolve from the reported `syncState`.
 *
 * (b) **62-21: the peer-to-peer card moved to `PeerTransportStatusCard.tsx`.** The peer-cluster
 *     transport ships **code-complete, unverified** (D-23/P2P-11 proof debt): P2P-11 is
 *     device-REFUTED, its wall has moved repeatedly, and this project has a documented history of
 *     "implemented but unproven" being read as "done" (Phase 45 closed with four such legs, Phase
 *     41's Node gate was device-REFUTED). `PeerTransportStatusCard` DOES now render real numeric
 *     counts (D-31) — unlike this file's two state-driven cards below, no prop reaches its border,
 *     caveat, heading or icon colour. See that component's own doc comment for the full structural
 *     severance argument this file's header used to carry for the retired `Experimental`-prefixed peer card.
 *
 * `disabled` on either card is a legibility/convenience control only, mirroring Phase 46's
 * `useCurrentOfficerScopes()` class of gate — it is **not** a security boundary.
 * `AdminSigning.SignerKeyValid` and `OfficerSignature.OfficerValid` are stub CHECKs (tracked under
 * Phase 999.1), so write controls here render **disabled, not hidden**, and no claim is made
 * anywhere in this file that the `'vrg'` scope gate is enforcement.
 */

/** A local view-model type — deliberately not imported from the engine seam, so this card can
 * render with no transport binding attached. */
export type TransportSyncState = "never" | "success" | "error";

/** `'p2p'` is deliberately absent from this union: passing the peer-to-peer binding through the
 * state-driven `TransportStatusCard` is a type error, not merely a style choice, because there is
 * no `TransportKind` value that would let it compile. */
export type TransportKind = "filesystem" | "rest";

/**
 * Per-state icon + color-role lookup for the filesystem/REST cards, in the
 * `{ state: { … } }[currentState]` shape copied from `SyncChip.tsx:31-35`.
 *
 * Every icon named here is verified present in the FontAwesome6 **Free** solid glyphmap
 * (`node_modules/react-native-vector-icons/glyphmaps/FontAwesome6Free_meta.json`). `SyncChip.tsx`
 * documents a live trap: `wifi-slash` is Pro-only and renders as a tofu glyph. Any future
 * addition to this table must be checked against that glyphmap the same way.
 *
 * `colorRole` is an indirection rather than a raw theme color so this stays a module-level
 * constant instead of being rebuilt from `useTheme()` on every render — the role is mapped to a
 * concrete color at the render site (`success -> colors.success`, `error -> colors.error`,
 * `muted -> colors.textSecondary`), feeding one const to both the icon and any state tint so they
 * can never disagree (the `statusColor` discipline from
 * `AttestationProvisioningStatusScreen.tsx:105`).
 */
export const TRANSPORT_STATE_ICONS: Record<
	TransportSyncState,
	{ icon: string; colorRole: "success" | "error" | "muted" }
> = {
	never: { icon: 'circle-question', colorRole: 'muted' },
	success: { icon: 'circle-check', colorRole: 'success' },
	error: { icon: 'circle-xmark', colorRole: 'error' },
};

/**
 * Per-state body-key lookup, mirroring `TRANSPORT_STATE_ICONS`'s own `Record` shape so a future
 * fourth `TransportSyncState` member is a compile error here, not a silent fallthrough into
 * whichever branch happened to be last. `bulkImportSyncLastSyncedLabel` is deliberately NOT a
 * member of this Record — after 48-24 it is a separate line rendered only behind a `lastSyncedAt`
 * truthiness guard (see the render body below), never a body key (48-UAT.md gap 1).
 */
export const TRANSPORT_BODY_KEYS: Record<TransportSyncState, string> = {
	never: 'bulkImportSyncNeverSyncedBody',
	success: 'bulkImportSyncSyncedBody',
	error: 'bulkImportSyncErrorBody',
};

/**
 * The ONE discriminant producing `testIDBase` + `headingKey` + `bodyKey` together (the
 * `provisioningCopy` discipline from `AttestationProvisioningStatusScreen.tsx:74-91`), so a
 * wrong-state heading can never render above a wrong-state body, and a future state addition adds
 * a branch here and nowhere else.
 *
 * The body key is a total function of `syncState` via `TRANSPORT_BODY_KEYS` — one distinct key
 * per state, including `error` (48-24 closed 48-UAT.md gap 1: an unattached or failed transport
 * used to fall through into the "Last synced" body with no date). The timestamp is a separate
 * guarded line elsewhere in this file so it can never render dateless.
 */
export function transportCopy(
	kind: TransportKind,
	syncState: TransportSyncState,
): { testIDBase: string; headingKey: string; bodyKey: string } {
	const headingKey =
		kind === "filesystem" ? "bulkImportSyncFilesystemHeading" : "bulkImportSyncRestHeading";
	return {
		testIDBase: `transport-status-${kind}-${syncState}`,
		headingKey,
		bodyKey: TRANSPORT_BODY_KEYS[syncState],
	};
}

/** Belt-and-suspenders no-op, matching the discipline at
 * `RegistrantDetailScreen.tsx:89` — `disabled` already gates the button visually and via
 * `CustomButton`'s native `disabled` prop; this ensures a stray `onPress` can never fire the
 * caller's handler while disabled. */
const NOOP = () => {};

interface TransportStatusCardProps {
	kind: TransportKind;
	syncState: TransportSyncState;
	lastSyncedAt?: string;
	importedCount?: number;
	pendingCount?: number;
	errorCount?: number;
	/** Legibility/convenience control only — mirrors Phase 46's `useCurrentOfficerScopes()` class
	 * of gate. NOT a security boundary (see file doc comment). */
	disabled?: boolean;
	onSyncNow: () => void;
}

export function TransportStatusCard({
	kind,
	syncState,
	lastSyncedAt,
	importedCount,
	pendingCount,
	errorCount,
	disabled = false,
	onSyncNow,
}: TransportStatusCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const copy = transportCopy(kind, syncState);
	const { icon, colorRole } = TRANSPORT_STATE_ICONS[syncState];
	// One const feeds both the icon and any state tint so they can never disagree — the
	// `statusColor` discipline from AttestationProvisioningStatusScreen.tsx:105.
	const statusColor =
		colorRole === "success" ? colors.success : colorRole === "error" ? colors.error : colors.textSecondary;

	const countSegments: string[] = [];
	if (importedCount !== undefined) {
		countSegments.push(t("bulkImportSyncImportedCountLabel", { count: importedCount }));
	}
	if (pendingCount !== undefined) {
		countSegments.push(t("bulkImportSyncPendingCountLabel", { count: pendingCount }));
	}
	if (errorCount !== undefined) {
		countSegments.push(t("bulkImportSyncErrorCountLabel", { count: errorCount }));
	}

	return (
		// No left border strip — its absence is the normal-case signal here, and is exactly what
		// makes the peer card's warning border read as a deviation rather than mere decoration.
		<View
			testID={`transport-status-card-${kind}`}
			style={[styles.cardSurface, { backgroundColor: colors.card }]}
		>
			<View style={localStyles.headingRow}>
				<View testID={`transport-status-icon-${kind}`}>
					<FontAwesome6 name={icon} size={16} color={statusColor} />
				</View>
				<ThemedText type="defaultSemiBold" testID={`${copy.testIDBase}-heading`}>
					{t(copy.headingKey)}
				</ThemedText>
			</View>

			{/* No second argument: removing the interpolation object is the structural guarantee that
			    no body string can receive a date any more (48-UAT.md gap 1). */}
			<ThemedText type="default" style={localStyles.bodyText} testID={`${copy.testIDBase}-body`}>
				{t(copy.bodyKey)}
			</ThemedText>

			{/* Guarded on lastSyncedAt truthiness alone — this is the date string's ONLY call site in
			    this file. That is what makes a dateless "Last synced" render unreachable: the string
			    simply has nowhere else to be printed from. Placed above the counts line so the reading
			    order is state sentence, then when it happened, then what it moved. */}
			{lastSyncedAt ? (
				<ThemedText
					type="small"
					style={[localStyles.countsText, { color: colors.textSecondary }]}
					testID={`transport-status-last-synced-${kind}`}
				>
					{/* WR-18: FORMATTED, never the raw value. `lastSyncedAt` arrives as
					    `TransportSyncReport.syncedAt`, produced by `new Date().toISOString()`, so
					    interpolating it directly showed the officer `2026-08-10T13:04:31.910Z`
					    where every other timestamp in this phase shows `2026-08-10`.
					    `formatRequestTimestamp` never throws and returns its input unchanged on an
					    unparseable value, so a malformed `syncedAt` degrades to the raw string
					    rather than blanking the line — the same contract the row and the approval
					    screen rely on. */}
					{t("bulkImportSyncLastSyncedLabel", { date: formatRequestTimestamp(lastSyncedAt) })}
				</ThemedText>
			) : null}

			{countSegments.length > 0 && (
				<ThemedText
					type="small"
					style={[localStyles.countsText, { color: colors.textSecondary }]}
					testID={`transport-status-counts-${kind}`}
				>
					{countSegments.join(" · ")}
				</ThemedText>
			)}

			<View testID={`transport-sync-now-${kind}`} style={localStyles.footer}>
				<CustomButton
					title={t("bulkImportSyncNowButton")}
					backgroundColor={colors.accent}
					size="thin"
					disabled={disabled}
					onPress={disabled ? NOOP : onSyncNow}
				/>
			</View>
		</View>
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
	countsText: {
		marginTop: 8,
	},
	footer: {
		marginTop: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
