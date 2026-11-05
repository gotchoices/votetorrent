import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../../components/ThemedText";
import type { KeyholderDkgRowState } from "../keyholder-dkg-driver";

/**
 * KeyholderDkgStatusRow — Phase 62 Plan 26, Surface 6. Renders 62-10's `keyholderDkg*` copy for
 * pending/inProgress/complete/complaint, plus an EXPLICIT `failed` variant this plan adds because
 * the UI-SPEC has no copy for the terminal DKG `failed` phase or a self-disqualification.
 * `failed` renders `keyholderDkgStatusFailed`, never the complaint copy — mapping it to
 * "Generation will restart" would promise a restart that will never happen for a terminal failure
 * (T-62-26-09). The copy is deliberately cause-agnostic: the row maps attempts-exhausted,
 * threshold-unreachable, an election key inconsistent with round 4 (the key may still be
 * releasable) and a self-disqualified keyholder (the others may still finish) to `failed` and
 * never sees which, so it names no failure, loss or restart.
 *
 * No prop reaches color or copy selection other than `state` — informational only, no touchable
 * control of any kind (the officer cannot force a DKG restart from here).
 */

interface KeyholderDkgStatusRowProps {
	state: KeyholderDkgRowState;
}

export function KeyholderDkgStatusRow({ state }: KeyholderDkgStatusRowProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	let glyph: string | undefined;
	let glyphColor: string | undefined;
	let textColor = colors.textSecondary;
	let text: string;

	switch (state) {
		case 'loading':
			text = t('loading');
			break;
		case 'pending':
			text = t('keyholderDkgStatusPending');
			break;
		case 'thresholdTooLow':
			glyph = 'triangle-exclamation';
			glyphColor = colors.warning;
			textColor = colors.warning;
			text = t('keyholderDkgStatusThresholdTooLow');
			break;
		case 'inProgress':
			text = t('keyholderDkgStatusInProgress');
			break;
		case 'complete':
			glyph = 'circle-check';
			glyphColor = colors.success;
			textColor = colors.success;
			text = t('keyholderDkgStatusComplete');
			break;
		case 'complaint':
			glyph = 'triangle-exclamation';
			glyphColor = colors.warning;
			textColor = colors.warning;
			text = t('keyholderDkgStatusComplaint');
			break;
		case 'failed':
			glyph = 'circle-xmark';
			glyphColor = colors.warning;
			textColor = colors.warning;
			text = t('keyholderDkgStatusFailed');
			break;
	}

	return (
		<View testID="keyholder-dkg-status-row" style={localStyles.row}>
			{glyph ? <FontAwesome6 name={glyph} size={16} color={glyphColor} /> : null}
			<View style={localStyles.column}>
				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t('keyholderDkgStatusHeading')}
				</ThemedText>
				<ThemedText testID={`keyholder-dkg-status-${state}`} type="small" style={[localStyles.stateText, { color: textColor }]}>
					{text}
				</ThemedText>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		marginTop: 8,
	},
	column: {
		marginLeft: 8,
		flexShrink: 1,
	},
	stateText: {
		flexShrink: 1,
	},
});
