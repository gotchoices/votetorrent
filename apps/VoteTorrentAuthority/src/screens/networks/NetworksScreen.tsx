import {ExtendedTheme, useTheme, useNavigation} from '@react-navigation/native';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, TextInput, TouchableOpacity, View} from 'react-native';
import {InfoCard} from '../../components/InfoCard';
import {ThemedText} from '../../components/ThemedText';
import {useApp} from '../../providers/AppProvider';
import type {AuthorityNetwork} from '@votetorrent/vote-core';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {NavigationProp} from '../../navigation/types';
import {ChipButton} from '../../components/ChipButton';
import {FullButton} from '../../components/FullButton';
import {globalStyles} from '../../theme/styles';
import {CustomTextInput} from '../../components/CustomTextInput';

export default function NetworksScreen() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const {networksEngine} = useApp();
	const [recentNetworks, setRecentNetworks] = useState<AuthorityNetwork[]>([]);
	const navigation = useNavigation<NavigationProp>();

	useEffect(() => {
		async function loadNetworks() {
			if (!networksEngine) {
				return;
			}
			const networks = await networksEngine.getRecentNetworks();
			setRecentNetworks(networks);
		}
		loadNetworks();
	}, [networksEngine]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton label={t('addNetwork')} icon={'circle-plus'} onPress={() => navigation.navigate('AddNetwork')} />
			)
		});
	}, []);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.section}>
					{t('useOneOfTheFollowingToGetConnected')}
				</ThemedText>
				<ThemedText type="title">{t('recentNetworks')}</ThemedText>
				{recentNetworks.map(network => (
					<View key={network.primaryAuthoritySid} style={styles.networkContainer}>
						<View style={styles.infoCardContainer}>
							<InfoCard
								image={{uri: network.imageRef.url}}
								title={network.name}
								additionalInfo={[
									{
										label: t('address'),
										value: network.relays[0] || 'No relays'
									}
								]}
								onPress={() => console.log(network)}
							/>
						</View>
						<View style={styles.iconContainer}>
							<TouchableOpacity style={styles.iconButton} onPress={() => console.log('Share network:', network.name)}>
								<FontAwesome6 name="share-nodes" size={20} color={colors.text} />
							</TouchableOpacity>
							<TouchableOpacity style={styles.iconButton} onPress={() => navigation.navigate('Hosting', {network})}>
								<FontAwesome6 name="database" size={20} color={colors.text} />
							</TouchableOpacity>
						</View>
					</View>
				))}
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('find')}</ThemedText>
				<CustomTextInput placeholder={t('enterAddressOrLocation')} />
				<FullButton
					title={t('useLocation')}
					backgroundColor={colors.important}
					forceDarkText={true}
					onPress={() => console.log('Use location')}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('scanQrCode')}</ThemedText>
				<FullButton title={t('scan')} onPress={() => console.log('Scan QR code')} />
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('enterBootstrap')}</ThemedText>
				<CustomTextInput placeholder={t('enterBootstrapPlaceholder')} />
				<FullButton title={t('useBootstrap')} onPress={() => console.log('Use bootstrap')} />
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	networkContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		marginBottom: 8
	},
	infoCardContainer: {
		flex: 1,
		marginRight: 8
	},
	iconContainer: {
		justifyContent: 'space-between',
		height: 80
	},
	iconButton: {
		padding: 8
	},
	input: {
		marginTop: 8,
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1
	}
});

const styles = {...globalStyles, ...localStyles};
