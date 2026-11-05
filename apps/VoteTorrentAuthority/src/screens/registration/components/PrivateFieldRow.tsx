import React, { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../../components/ThemedText";

/**
 * PrivateFieldRow — the registrant-detail private-tier field row (D-01/D-13/D-14).
 *
 * This is the only component in Phase 47 that ever holds an SSN, date of
 * birth, or phone number in a prop. It renders masked by default, reveals on
 * tap, and emits the revealed field's NAME (never the value) upward for the
 * D-14 visit accumulator.
 *
 * Never-log rule (D-01 / T-47-02): a private value has exactly ONE
 * destination in this component — a `<ThemedText>` child on the revealed
 * branch. This file writes nothing to the debug console, declares no error
 * state, performs no serialization, and binds no value into a translated
 * string. A future edit that adds any of those is a regression against this
 * contract, gated structurally by `private-tier-invariants.test.tsx`.
 *
 * D-14: there is deliberately NO retraction callback (`onHide` /
 * `onConceal` / `onRetract` / `onUnreveal` / `onMask`) in this file or in
 * `PrivateFieldRowProps`. Reveal state is component-local and one-way
 * outward — the officer already saw the field, so the access-trail record
 * stands regardless of subsequent re-masking. The absence of a retraction
 * prop is the enforcement, not a convention.
 *
 * The mask itself is a disclosure-minimization affordance for a value the
 * app already holds decrypted on device, not an access-control boundary.
 * The real controls are the schema's `'vrg'` `AdminSignature` CHECKs and
 * 47-20's D-13 gate (which decides whether this component renders AT ALL for
 * an officer lacking `'vrg'`). This component carries no scope logic and
 * imports no engine, no officer-scope hook, and no navigation hook.
 */

export interface PrivateFieldRowProps {
	/** PrivateDetail.name — the field NAME. */
	name: string;
	/** Already-stringified display value; caller owns flattening. */
	value: string;
	/** Fired on every masked -> revealed transition, with the field NAME only. */
	onReveal: (fieldName: string) => void;
	testIDPrefix?: string;
}

export function PrivateFieldRow({ name, value, onReveal, testIDPrefix = "private-field" }: PrivateFieldRowProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [revealed, setRevealed] = useState(false);

	function handlePress() {
		// `next` is derived OUTSIDE the updater and the side effect fires
		// outside it too. React state updaters must be pure: React
		// double-invokes them in StrictMode/dev and may re-invoke them during
		// concurrent rendering, so an `onReveal(name)` call inside the updater
		// fired twice per tap in dev and had no once-per-tap guarantee at all
		// under concurrent rendering. The Set inside createAccessTrailVisit
		// absorbed the duplicate, which made that accumulator's dedup
		// load-bearing for a property that should be structural — and would
		// break the moment the accumulator became order-sensitive.
		const next = !revealed;
		setRevealed(next);
		// Only the false -> true edge emits. The true -> false (re-mask)
		// edge calls nothing at all (D-14) — there is no retraction.
		if (next) {
			onReveal(name);
		}
	}

	return (
		<View testID={`${testIDPrefix}-row-${name}`} style={localStyles.propertyRow}>
			<TouchableOpacity
				testID={`${testIDPrefix}-toggle-${name}`}
				onPress={handlePress}
				accessibilityRole="button"
				accessibilityLabel={t(revealed ? "registrantDetailPrivateHideHint" : "registrantDetailPrivateRevealHint")}
				hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
				style={localStyles.tapTarget}
			>
				{/*
				 * The reveal/hide hint keys drive accessibilityLabel rather than
				 * visible per-row text — these rows are dense and the glyph state
				 * (eye / eye-slash) already carries the affordance visually. Both
				 * keys ARE consumed, just not as rendered text.
				 */}
				<ThemedText type="defaultSemiBold" style={localStyles.propertyName}>
					{name}:{" "}
				</ThemedText>
				<View testID={`${testIDPrefix}-value-${name}`} style={localStyles.propertyValue}>
					{revealed ? (
						<ThemedText type="default" style={{ color: colors.text }}>
							{value}
						</ThemedText>
					) : (
						<ThemedText type="default" style={{ color: colors.textSecondary }}>
							{t("registrantDetailPrivateMaskedValue")}
						</ThemedText>
					)}
				</View>
				<View style={localStyles.glyphBox}>
					<FontAwesome6
						name={revealed ? "eye-slash" : "eye"}
						size={18}
						color={revealed ? colors.text : colors.textSecondary}
					/>
				</View>
			</TouchableOpacity>
		</View>
	);
}

const localStyles = StyleSheet.create({
	propertyRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		width: "100%",
	},
	propertyName: {
		marginRight: 4,
		textTransform: "capitalize",
	},
	propertyValue: {
		flex: 1,
	},
	tapTarget: {
		minHeight: 44,
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	glyphBox: {
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
});
