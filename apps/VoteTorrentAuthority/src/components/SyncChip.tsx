import React from 'react';
import {StyleSheet, View} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import {ThemedText} from './ThemedText';
import {useCadreNode} from '../providers/CadreNodeProvider';

/**
 * SyncChip — P2P-07 + D-14 config-fault precedence (56-10)
 *
 * A single, global, non-interactive chip that reflects the CadreNode fabric
 * sync state. State is read from useCadreNode() — it arrives via CadreNode
 * events registered in CadreNodeProvider (D-10: event-driven, NO polling /
 * NO setInterval here). Display-only: no onPress, no privileged action gated
 * on the state (T-22-11 accepted).
 *
 * State → presentation (configFault takes precedence over syncState — a
 * bootstrap-configuration fault is a DIFFERENT condition from being offline:
 * offline means peers were unreachable, a fault means the app was never told
 * which peers to reach):
 *   configFault != null → orange 'triangle-exclamation' icon + Not configured label
 *   'connected'         → green  'wifi'                 icon + Connected label
 *   'syncing'           → orange 'rotate'                icon + Syncing label
 *   'offline'           → red    'link-slash'            icon + Offline label
 *
 * Note: icon names must exist in the FontAwesome6 *Free* glyphmap — 'wifi-slash'
 * is Pro-only and renders as a tofu "?" glyph, so 'link-slash' is used for offline;
 * 'triangle-exclamation' is confirmed present in the Free solid set.
 */
export function SyncChip() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const {syncState, configFault} = useCadreNode();

	const presentation = configFault
		? {icon: 'triangle-exclamation', color: colors.warning, textColor: colors.warningText, label: t('syncNotConfigured')}
		: {
				connected: {icon: 'wifi', color: colors.success, textColor: colors.success, label: t('syncConnected')},
				syncing: {icon: 'rotate', color: colors.warning, textColor: colors.warningText, label: t('syncSyncing')},
				offline: {icon: 'link-slash', color: colors.error, textColor: colors.error, label: t('syncOffline')},
			}[syncState];

	return (
		<View style={[styles.chip, {backgroundColor: colors.card}]}>
			<FontAwesome6 name={presentation.icon} size={14} color={presentation.color} />
			<ThemedText type="small" numberOfLines={1} style={{color: presentation.textColor ?? presentation.color}}>
				{presentation.label}
			</ThemedText>
		</View>
	);
}

const styles = StyleSheet.create({
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		height: 32,
		paddingHorizontal: 12,
		borderRadius: 16,
		alignSelf: 'flex-start',
		gap: 8,
	},
});
