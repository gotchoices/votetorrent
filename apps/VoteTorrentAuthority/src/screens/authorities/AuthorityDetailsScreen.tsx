import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Image, ScrollView, StyleSheet, View} from 'react-native';
import {ChipButton} from '../../components/ChipButton';
import {InfoCard} from '../../components/InfoCard';
import {ThemedText} from '../../components/ThemedText';
import type {Authority, Administration} from '@votetorrent/vote-core';
import {useNavigation, useRoute} from '@react-navigation/native';
import {FullButton} from '../../components/FullButton';
import type {RootStackParamList} from '../../navigation/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useApp} from '../../providers/AppProvider';
import {AuthorizationSection} from '../../components/AuthorizationSection';
import {globalStyles} from '../../theme/styles';

export default function AuthorityDetailsScreen() {
	const {t} = useTranslation();
	const {authority} = useRoute().params as {authority: Authority};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const {networkEngine} = useApp();
	const [pinned, setPinned] = useState(false);
	const [administration, setAdministration] = useState<Administration | null>(null);
	const [proposedAdministration, setProposedAdministration] = useState<Administration | null>(null);

	useEffect(() => {
		async function getAuthorityData() {
			if (!networkEngine) return;
			try {
				const pinnedAuthorities = await networkEngine.getPinnedAuthorities();
				setPinned(pinnedAuthorities.some((a: Authority) => a.sid === authority.sid));
				const administration = await networkEngine.getAdministration(authority.sid);
				setAdministration(administration);
				const proposedAdministration = await networkEngine.getProposedAdministration(authority.sid);
				if (proposedAdministration) {
					setProposedAdministration(proposedAdministration);
				}
			} catch (error) {
				console.error('Error checking pinned status:', error);
			}
		}
		getAuthorityData();
	}, [networkEngine, authority.sid]);

	if (!authority || !networkEngine) {
		return null;
	}

	const authorityDetails = [
		{label: t('name'), value: authority.name},
		{
			label: t('domainName'),
			value: authority.domainName
		},
		{label: t('sid'), value: authority.sid},
		{label: t('address'), value: authority.domainName},
		{label: t('signature'), value: authority.signature}
	];

	const administrationDetails = [
		{label: t('sid'), value: administration?.sid || ''},
		{label: t('handoffSignature'), value: administration?.signatures?.[0]},
		{label: t('expires'), value: administration?.expiration}
	];

	const proposedAdministrationDetails = [
		{label: t('sid'), value: proposedAdministration?.sid || ''},
		{label: t('handoffSignature'), value: proposedAdministration?.signatures?.[0]},
		{label: t('expires'), value: proposedAdministration?.expiration}
	];

	const handlePinToggle = async () => {
		try {
			if (pinned) {
				await networkEngine.unpinAuthority(authority.sid);
			} else {
				await networkEngine.pinAuthority(authority);
			}
			setPinned(!pinned);
		} catch (error) {
			console.error('Error toggling authority pin:', error);
		}
	};

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={pinned ? t('unpin') : t('pin')}
					icon={pinned ? 'thumbtack-slash' : 'thumbtack'}
					onPress={handlePinToggle}
				/>
			)
		});
	}, [pinned, navigation, t]);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.imageContainer}>
					<Image source={{uri: authority.imageRef?.url}} style={styles.authorityImage} />
				</View>
				{authorityDetails.map(detail => (
					<View key={detail.label} style={styles.detail}>
						<ThemedText type="defaultSemiBold">{detail.label}: </ThemedText>
						<ThemedText>{detail.value}</ThemedText>
					</View>
				))}
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t('administration')}</ThemedText>

				{administrationDetails.map(detail => (
					<View key={detail.label} style={styles.detail}>
						<ThemedText type="defaultSemiBold">{detail.label}: </ThemedText>
						<ThemedText>{detail.value}</ThemedText>
					</View>
				))}

				{administration?.administrators.map(admin => (
					<InfoCard
						key={admin.sid}
						image={{uri: admin.imageRef?.url || ''}}
						title={admin.name}
						additionalInfo={[
							{
								label: t('title'),
								value: admin.title
							},
							{label: t('sid'), value: admin.sid}
						]}
						icon="chevron-right"
						onPress={() =>
							navigation.navigate('AdministratorDetails', {
								administrator: admin
							})
						}
					/>
				))}

				{!proposedAdministration && (
					<FullButton
						title={t('reviseAdministration')}
						icon="pen"
						size="thin"
						onPress={() =>
							navigation.navigate('ReplaceAdministration', {
								authority: authority
							})
						}
					/>
				)}
			</View>

			{proposedAdministration && (
				<View>
					<View style={styles.section}>
						<ThemedText type="title">{t('proposedAdministration')}</ThemedText>
						{proposedAdministrationDetails.map(detail => (
							<View key={detail.label} style={styles.detail}>
								<ThemedText type="defaultSemiBold">{detail.label}: </ThemedText>
								<ThemedText>{detail.value}</ThemedText>
							</View>
						))}

						{proposedAdministration?.administrators.map(admin => (
							<InfoCard
								key={admin.sid}
								image={{uri: admin.imageRef?.url || ''}}
								title={admin.name}
								additionalInfo={[
									{
										label: t('title'),
										value: admin.title
									},
									{label: t('sid'), value: admin.sid}
								]}
								icon="chevron-right"
								onPress={() =>
									navigation.navigate('AdministratorDetails', {
										administrator: admin
									})
								}
							/>
						))}
					</View>

					<AuthorizationSection administration={administration} />
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	imageContainer: {
		position: 'relative',
		width: 200,
		height: 200,
		alignSelf: 'center',
		marginVertical: 16
	},
	authorityImage: {
		width: '100%',
		height: '100%',
		borderRadius: 8
	},
	detail: {
		flexDirection: 'row'
	}
});

const styles = {...globalStyles, ...localStyles};
