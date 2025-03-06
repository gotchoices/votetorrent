import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {ImageSourcePropType} from 'react-native';
import {InfoCard} from '../../components/InfoCard';
import {CollapsibleSection} from '../../components/CollapsibleSection';
import {ChipButton} from '../../components/ChipButton';
import {ThemedText} from '../../components/ThemedText';
import React, {useState} from 'react';
import {useNavigation} from '@react-navigation/native';
import type {NavigationProp} from '../../navigation/types';

export interface Authority {
  id: string;
  image: ImageSourcePropType;
  title: string;
  domainName: string;
  cid: string;
  address: string;
  signature: string;
  isPinned: boolean;
}

const INITIAL_AUTHORITIES: Authority[] = [
  {
    id: '1',
    image: require('../../assets/images/utah-flag.png'),
    title: 'Utah State Elections',
    domainName: 'utah.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/utah.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: true,
  },
  {
    id: '2',
    image: require('../../assets/images/utah-flag.png'),
    title: 'Salt Lake County',
    domainName: 'slco.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/slco.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: true,
  },
  {
    id: '3',
    image: require('../../assets/images/utah-flag.png'),
    title: 'Utah County',
    domainName: 'utahcounty.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/utahcounty.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: true,
  },
  {
    id: '4',
    image: require('../../assets/images/utah-flag.png'),
    title: 'Provo City',
    domainName: 'provo.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/provo.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: false,
  },
  {
    id: '5',
    image: require('../../assets/images/utah-flag.png'),
    title: 'Orem City',
    domainName: 'orem.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/orem.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: false,
  },
  {
    id: '6',
    image: require('../../assets/images/utah-flag.png'),
    title: 'West Jordan City',
    domainName: 'westjordan.gov',
    cid: 'QmZjkl4GIafds123',
    address: '/dns/westjordan.gov/tcp/443/p2p/QmZjkls123',
    signature: '[valid]',
    isPinned: false,
  },
];

const getPinnedAuthorities = () => {
  return INITIAL_AUTHORITIES.filter(authority => authority.isPinned);
};

const getAuthoritiesByName = () => {
  return INITIAL_AUTHORITIES.filter(authority => !authority.isPinned);
};

const pinAuthority = (authority: Authority) => {
  const updatedAuthorities = INITIAL_AUTHORITIES.map(a =>
    a.id === authority.id ? {...a, isPinned: true} : a,
  );
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
            key={authority.id}
            image={authority.image}
            title={authority.title}
            additionalInfo={[
              {label: 'CID', value: authority.cid},
              {label: 'Address', value: authority.address},
            ]}
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
              key={authority.id}
              image={authority.image}
              title={authority.title}
              additionalInfo={[
                {label: 'CID', value: authority.cid},
                {label: 'Address', value: authority.address},
              ]}
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
