import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useUnsharedCommitCount} from '../hooks/useCommitShare';

/**
 * UnsharedChangesNotice -- writes on this phone that no other member of the election network holds
 * yet (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort). Rendered next to
 * ConfigFaultNotice on Home; renders nothing at 0, and outside CommitShareContext (count is 0).
 * Display-only. Votes are not counted here: a cast vote is stored on the phone, not in the strand,
 * and the receipt already says whether it has been sent.
 */
export function UnsharedChangesNotice() {
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	const count = useUnsharedCommitCount();

	if (count <= 0) {
		return null;
	}

	return (
		<View testID="unshared-changes-notice" style={[styles.notice, {backgroundColor: colors.card}]} accessibilityLiveRegion="polite">
			<FontAwesome6 name="cloud-arrow-up" size={14} color={colors.warning} />
			<Text style={{color: colors.warning, fontSize: typeScale.caption.fontSize, flexShrink: 1}}>
				{t('unsharedChanges', {count})}
			</Text>
		</View>
	);
}

export default UnsharedChangesNotice;

const styles = StyleSheet.create({
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 8,
		gap: 8,
	},
});
