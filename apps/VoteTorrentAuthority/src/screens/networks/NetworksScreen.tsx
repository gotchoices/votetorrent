import {ExtendedTheme, useTheme} from '@react-navigation/native';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
	ScrollView,
	StyleSheet,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import {InfoCard} from '../../components/InfoCard';
import {ThemedText} from '../../components/ThemedText';
import {useApp} from '../../providers/AppProvider';
import type {ElectionEngineInit} from '@votetorrent/vote-core';

export default function NetworksScreen() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const {networksEngine} = useApp();
	const [recentNetworks, setRecentNetworks] = useState<ElectionEngineInit[]>(
		[],
	);

	useEffect(() => {
		async function loadNetworks() {
			const networks = await networksEngine.getRecentNetworks();
			setRecentNetworks(networks);
		}
		loadNetworks();
	}, [networksEngine]);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<ThemedText type="title">{t('recentNetworks')}</ThemedText>
				{recentNetworks.map(network => (
					<InfoCard
						key={network.primaryAuthoritySid}
						image={{uri: network.imageUrl}}
						title={network.name}
						additionalInfo={[
							{
								label: t('address'),
								value: network.bootstrap[0] || 'No bootstrap addresses',
							},
						]}
						onPress={() => console.log(network)}
					/>
				))}
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('find')}</ThemedText>
				<TextInput
					style={[
						styles.input,
						{backgroundColor: colors.card, color: colors.text},
						{borderColor: colors.border},
					]}
					placeholder={t('enterAddressOrLocation')}
					placeholderTextColor={colors.text}
				/>
				<TouchableOpacity
					style={[styles.button, {backgroundColor: colors.accent}]}
					onPress={() => console.log('Use location')}>
					<ThemedText>{t('useLocation')}</ThemedText>
				</TouchableOpacity>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('scanQrCode')}</ThemedText>
				<TouchableOpacity
					style={[styles.button, {backgroundColor: colors.accent}]}
					onPress={() => console.log('Scan QR code')}>
					<ThemedText>{t('scan')}</ThemedText>
				</TouchableOpacity>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('enterBootstrap')}</ThemedText>
				<TextInput
					style={[
						styles.input,
						{backgroundColor: colors.card, color: colors.text},
						{borderColor: colors.border},
					]}
					placeholder={t('enterBootstrapPlaceholder')}
					placeholderTextColor={colors.text}
				/>
				<TouchableOpacity
					style={[styles.button, {backgroundColor: colors.accent}]}
					onPress={() => console.log('Use bootstrap')}>
					<ThemedText>{t('useBootstrap')}</ThemedText>
				</TouchableOpacity>
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		padding: 16,
	},
	section: {
		marginBottom: 24,
	},
	input: {
		marginTop: 8,
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
	},
	button: {
		marginTop: 8,
		padding: 12,
		borderRadius: 32,
		alignItems: 'center',
	},
});
