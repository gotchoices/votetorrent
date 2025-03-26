import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {InfoCard} from '../../components/InfoCard';
import {CollapsibleSection} from '../../components/CollapsibleSection';
import {ChipButton} from '../../components/ChipButton';
import {ThemedText} from '../../components/ThemedText';
import React, {useState} from 'react';
import {useNavigation} from '@react-navigation/native';
import type {NavigationProp} from '../../navigation/types';
import type {Authority} from '@votetorrent/vote-core';
import {MockElectionEngine} from '@votetorrent/vote-core';

const INITIAL_AUTHORITIES: Authority[] = [
	{
		sid: '1',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'Utah State Elections',
		domainName: 'utah.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '2',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'Salt Lake County',
		domainName: 'slco.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '3',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'Utah County',
		domainName: 'utahcounty.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '4',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'Provo City',
		domainName: 'provo.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '5',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'Orem City',
		domainName: 'orem.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '6',
		imageUrl: require('../../assets/images/utah-flag.png'),
		name: 'West Jordan City',
		domainName: 'westjordan.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
];

const getPinnedAuthorities = () => {
	return INITIAL_AUTHORITIES.slice(0, 3);
};

const getAuthoritiesByName = () => {
	return INITIAL_AUTHORITIES.slice(3);
};

const pinAuthority = (authority: Authority) => {
	// const updatedAuthorities = INITIAL_AUTHORITIES.map(a =>
	// 	a.said === authority.said ? {...a} : a,
	// );
};

export default function AuthoritiesScreen() {
	const [searchText, setSearchText] = useState('');
	const pinnedAuthorities = getPinnedAuthorities();
	const unpinnedAuthorities = getAuthoritiesByName();
	const {t} = useTranslation();
	const navigation = useNavigation<NavigationProp>();

	const handlePinToggle = (authority: Authority) => {
		pinAuthority(authority);
	};

	return (
		<ScrollView style={styles.container}>
			{pinnedAuthorities.length > 0 ? (
				pinnedAuthorities.map((authority: Authority) => (
					<InfoCard
						key={authority.sid}
						title={authority.name}
						additionalInfo={[{label: 'CID', value: authority.imageCid}]}
						icon={'chevron-right'}
						onPress={() => {
							navigation.navigate('AuthorityDetails', {
								authority: authority,
							});
						}}
					/>
				))
			) : (
				<ThemedText style={styles.emptyText}>
					{t('noPinnedAuthorities')}
				</ThemedText>
			)}

			<View style={styles.buttonContainer}>
				<ChipButton
					label={t('addAuthority')}
					icon="circle-plus"
					onPress={() => {
						console.log('Add authority pressed');
					}}
				/>
			</View>

			<CollapsibleSection
				title={t('find')}
				searchPlaceholder={t('filterAuthorities')}
				onSearch={setSearchText}>
				{unpinnedAuthorities.length > 0 ? (
					unpinnedAuthorities.map(authority => (
						<InfoCard
							key={authority.sid}
							title={authority.name}
							additionalInfo={[{label: 'CID', value: authority.imageCid}]}
							icon={'thumbtack'}
							onPress={() => handlePinToggle(authority)}
						/>
					))
				) : (
					<ThemedText style={styles.emptyText}>No authorities found</ThemedText>
				)}
			</CollapsibleSection>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		margin: 16,
	},
	centerContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},
	buttonContainer: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		marginVertical: 8,
	},
	emptyText: {
		textAlign: 'center',
		marginVertical: 16,
		opacity: 0.7,
	},
});
