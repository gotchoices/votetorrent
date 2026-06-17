import React from 'react';
import {StyleSheet, View} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import {ThemedText} from './ThemedText';
import {useCadreNode} from '../providers/CadreNodeProvider';

/**
 * SyncChip — P2P-07
 *
 * A single, global, non-interactive chip that reflects the CadreNode fabric
 * sync state. State is read from useCadreNode() — it arrives via CadreNode
 * events registered in CadreNodeProvider (D-10: event-driven, NO polling /
 * NO setInterval here). Display-only: no onPress, no privileged action gated
 * on the state (T-22-11 accepted).
 *
 * State → presentation:
 *   'connected' → green  'wifi'        icon + Connected label
 *   'syncing'   → orange 'rotate'      icon + Syncing label
 *   'offline'   → red    'wifi-slash'  icon + Offline label
 */
export function SyncChip() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const {syncState} = useCadreNode();

	const presentation = {
		connected: {icon: 'wifi', color: colors.success, label: t('syncConnected')},
		syncing: {icon: 'rotate', color: colors.warning, label: t('syncSyncing')},
		offline: {icon: 'wifi-slash', color: colors.error, label: t('syncOffline')},
	}[syncState];

	return (
		<View style={[styles.chip, {backgroundColor: colors.card}]}>
			<FontAwesome6 name={presentation.icon} size={14} color={presentation.color} />
			<ThemedText type="small" numberOfLines={1} style={{color: presentation.color}}>
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
