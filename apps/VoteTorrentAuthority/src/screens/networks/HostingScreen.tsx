import {ExtendedTheme, useTheme} from '@react-navigation/native';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, TextInput, TouchableOpacity, View, Linking} from 'react-native';
import {ThemedText} from '../../components/ThemedText';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ChipButton} from '../../components/ChipButton';
import {InfoCard} from '../../components/InfoCard';
import {globalStyles} from '../../theme/styles';
import {CustomTextInput} from '../../components/CustomTextInput';

const MOCK_PROVIDERS = [
	{
		id: '1',
		name: 'Casa de Vote',
		additionalInfo: [{label: 'Providing the best server infrastructure West of the Rockies'}]
	},
	{
		id: '2',
		name: 'Host-it Now',
		additionalInfo: [{label: 'Hosting provider in the US'}]
	}
];

export default function HostingScreen() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();

	const openInstructions = () => {
		Linking.openURL('https://votetorrent.org');
	};

	return (
		<View style={styles.container}>
			<ScrollView>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('statistics')}
					</ThemedText>
					<View style={styles.statRow}>
						<ThemedText type="defaultSemiBold">{t('estimatedNodes')}</ThemedText>
						<ThemedText type="defaultSemiBold">42</ThemedText>
					</View>
					<View style={styles.statRow}>
						<ThemedText type="defaultSemiBold">{t('estimatedServers')}</ThemedText>
						<ThemedText type="defaultSemiBold">12</ThemedText>
					</View>
				</View>

				<View style={styles.sectionTitle}>
					<ThemedText type="defaultSemiBold">{t('addServersToThisNetwork')}</ThemedText>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('hostMyOwn')}
					</ThemedText>
					<CustomTextInput
						title={t('configuration')}
						placeholder={t('serverConfigurationPlaceholder')}
						icon="share-nodes"
						onIconPress={() => console.log('Share')}
					/>
					<ThemedText style={styles.instructionsText}>
						{t('seeInstructions')}{' '}
						<ThemedText type="link" onPress={openInstructions}>
							{t('votetorrentInstructions')}
						</ThemedText>{' '}
						{t('forConfiguringAServer')}
					</ThemedText>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('useHostingProvider')}
					</ThemedText>
					{MOCK_PROVIDERS.map(provider => (
						<InfoCard
							key={provider.id}
							title={provider.name}
							additionalInfo={provider.additionalInfo}
							icon="chevron-right"
						/>
					))}
					<View style={styles.addProviderContainer}>
						<ChipButton label={t('addProvider')} icon="circle-plus" onPress={() => console.log('Add provider')} />
					</View>
				</View>
			</ScrollView>
		</View>
	);
}

const localStyles = StyleSheet.create({
	statRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 8
	},
	fieldLabel: {
		marginBottom: 8
	},
	inputContainer: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8
	},
	input: {
		flex: 1,
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
		textAlignVertical: 'top'
	},
	shareButton: {
		padding: 16
	},
	instructionsText: {
		marginTop: 8
	},
	addProviderContainer: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		marginTop: 16
	}
});

const styles = {...globalStyles, ...localStyles};
