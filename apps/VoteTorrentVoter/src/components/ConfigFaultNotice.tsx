/**
 * ConfigFaultNotice — the Voter app's user-visible bootstrap-configuration-
 * fault surface (D-14, 56-10).
 *
 * This is its own component, rather than folded into `NetworkHeader`,
 * because `NetworkHeader` declares itself presentational in its own header
 * doc comment — "no provider/navigation reads here" — and this notice must
 * call `useCadreNode()`.
 *
 * A configuration fault is NOT the same condition as being offline: offline
 * means the app tried to reach peers and could not; a fault means the app
 * was never told which peers to reach at all (an absent, empty or malformed
 * `bootstrap.config.json`). Conflating the two would make a misconfigured
 * release build look identical to a correctly-configured one whose peers
 * happen to be down — the exact silent failure D-14 exists to end.
 *
 * Renders nothing when `configFault` is `null` — a correctly configured app
 * shows no chrome at all. Presentational otherwise: no `onPress`, no
 * navigation, no privileged action gated on it.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useCadreNode} from '../providers/CadreNodeProvider';

export function ConfigFaultNotice() {
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	const {configFault} = useCadreNode();

	if (!configFault) {
		return null;
	}

	return (
		<View testID="config-fault-notice" style={[styles.notice, {backgroundColor: colors.card}]}>
			<FontAwesome6 name="triangle-exclamation" size={14} color={colors.warning} />
			<Text style={{color: colors.warning, fontSize: typeScale.caption.fontSize}}>
				{t('configNotConfigured')}
			</Text>
		</View>
	);
}

export default ConfigFaultNotice;

const styles = StyleSheet.create({
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 8,
		gap: 8,
	},
});
