import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ExtendedTheme, useNavigation, useTheme} from '@react-navigation/native';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {
  Image,
  ImageSourcePropType,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import {ChipButton} from '../../components/ChipButton';
import {InfoCard} from '../../components/InfoCard';
import {ThemedText} from '../../components/ThemedText';
import {Authority} from './AuthoritiesScreen';
import {useRoute} from '@react-navigation/native';

export interface Administrator {
  id: string;
  image: ImageSourcePropType;
  name: string;
  position: string;
  cid: string;
}

export const mockAdmins: Administrator[] = [
  {
    id: '1',
    image: require('../../assets/images/stock-man.jpg'),
    name: 'John Doe',
    position: 'County Clerk',
    cid: 'QmX40sdfn2T54',
  },
  {
    id: '2',
    image: require('../../assets/images/stock-woman.jpg'),
    name: 'Jane Smith',
    position: 'Assistant County Clerk',
    cid: 'QmY40sdfn2T54',
  },
];

export default function AuthorityDetailsScreen() {
  const {colors} = useTheme() as ExtendedTheme;
  const {t} = useTranslation();
  const {authority} = useRoute().params as {authority: Authority};
  const authorityData = authority;
  const navigation = useNavigation();

  if (!authorityData) {
    return null;
  }

  const authorityDetails = [
    {label: t('name'), value: authorityData.title},
    {
      label: t('domainName'),
      value: authorityData.domainName,
    },
    {label: t('cid'), value: authorityData.cid},
    {label: t('address'), value: authorityData.address},
    {label: t('signature'), value: authorityData.signature},
  ];

  const adminFields = [
    {label: t('cid'), value: 'QmAsdn$(leRJ456'},
    {label: t('priorCid'), value: 'QmBasdn$2nfs789'},
    {label: t('handoffSignature'), value: '[valid]'},
    {label: t('expires'), value: 'December 31, 2025'},
  ];

  const handlePinToggle = (id: string) => {
    //dispatch(togglePin(id));
  };

  React.useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <ChipButton
          label={authorityData.isPinned ? t('unpin') : t('pin')}
          icon={authorityData.isPinned ? 'thumbtack-slash' : 'thumbtack'}
          onPress={() => handlePinToggle(authorityData.id)}
        />
      ),
    });
  }, [authorityData.isPinned]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <ThemedText type="title">{t('authority')}</ThemedText>
        <Image
          source={authorityData.image}
          style={styles.authorityImage}
          resizeMode="contain"
        />
        {authorityDetails.map(field => (
          <View key={field.label} style={styles.field}>
            <ThemedText type="defaultSemiBold">{field.label}: </ThemedText>
            <ThemedText>{field.value}</ThemedText>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <ThemedText type="title">{t('administration')}</ThemedText>
        {adminFields.map(field => (
          <View key={field.label} style={styles.field}>
            <ThemedText type="defaultSemiBold">{field.label}: </ThemedText>
            <ThemedText>{field.value}</ThemedText>
          </View>
        ))}

        {mockAdmins.map(admin => (
          <InfoCard
            key={admin.id}
            image={admin.image}
            title={admin.name}
            additionalInfo={[
              {
                label: t('position'),
                value: admin.position,
              },
              {label: t('cid'), value: admin.cid},
            ]}
            icon="chevron-right"
            onPress={() => console.log(`Pressed ${admin.name}`)}
          />
        ))}

        <TouchableOpacity
          style={[styles.handoffButton, {backgroundColor: colors.contrast}]}
          onPress={() => console.log('Hand-off')}>
          <ThemedText style={[styles.handoffText, {color: colors.card}]}>
            {t('handoff')}
          </ThemedText>
          <FontAwesome6
            name="triangle-exclamation"
            size={16}
            color={colors.warning}
            style={styles.handoffIcon}
          />
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
  authorityImage: {
    height: 100,
    alignSelf: 'center',
    marginVertical: 16,
  },
  field: {
    flexDirection: 'row',
  },
  handoffButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 32,
    marginTop: 16,
  },
  handoffIcon: {
    marginLeft: 8,
  },
  handoffText: {
    fontWeight: 'bold',
  },
});
