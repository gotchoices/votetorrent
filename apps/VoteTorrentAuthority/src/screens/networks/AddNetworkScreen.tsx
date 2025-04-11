import {ExtendedTheme, useTheme} from '@react-navigation/native';
import React, {useState, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, TextInput, TouchableOpacity, View, Image, useColorScheme} from 'react-native';
import {ThemedText} from '../../components/ThemedText';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ChipButton} from '../../components/ChipButton';
import {FullButton} from '../../components/FullButton';
import {globalStyles} from '../../theme/styles';
import {CustomTextInput} from '../../components/CustomTextInput';

export default function AddNetworkScreen() {
	const {colors} = useTheme() as ExtendedTheme;
	const colorScheme = useColorScheme();
	const {t} = useTranslation();
	const [networkName, setNetworkName] = useState('');
	const [networkImageUrl, setNetworkImageUrl] = useState('');
	const [authorityName, setAuthorityName] = useState('');
	const [authorityImageUrl, setAuthorityImageUrl] = useState('');
	const [domainName, setDomainName] = useState('');
	const [adminName, setAdminName] = useState('');
	const [adminTitle, setAdminTitle] = useState('');
	const [isSigned, setIsSigned] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [relayAddresses, setRelayAddresses] = useState(['']);
	const scrollViewRef = useRef<ScrollView>(null);

	const toggleAdvanced = () => {
		if (!showAdvanced) {
			setTimeout(() => {
				scrollViewRef.current?.scrollToEnd({animated: true});
			}, 100);
		}
		setShowAdvanced(!showAdvanced);
	};

	const addRelayField = () => {
		setRelayAddresses([...relayAddresses, '']);
	};

	const updateRelayAddress = (index: number, value: string) => {
		const newAddresses = [...relayAddresses];
		newAddresses[index] = value;
		setRelayAddresses(newAddresses);
	};

	const removeRelayField = (index: number) => {
		if (relayAddresses.length > 1) {
			const newAddresses = relayAddresses.filter((_, i) => i !== index);
			setRelayAddresses(newAddresses);
		}
	};

	const handleMakePermanent = () => {
		//TODO: Implement make permanent
		console.log('Make permanent');
	};

	return (
		<View style={styles.content}>
			<ScrollView ref={scrollViewRef} style={styles.container}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t('createNewNetwork')}
				</ThemedText>

				<View style={styles.section}>
					<CustomTextInput title={t('name')} value={networkName} onChangeText={setNetworkName} />
					<CustomTextInput
						title={t('imageUrl')}
						value={networkImageUrl}
						placeholder={t('optionalImageAddress')}
						onChangeText={setNetworkImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{networkImageUrl ? (
						<Image source={{uri: networkImageUrl}} style={styles.previewImage} resizeMode="cover" />
					) : null}
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('primaryAuthority')}
					</ThemedText>
					<CustomTextInput title={t('name')} value={authorityName} onChangeText={setAuthorityName} />
					<CustomTextInput
						title={t('imageUrl')}
						value={authorityImageUrl}
						placeholder={t('optionalImageAddress')}
						onChangeText={setAuthorityImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{authorityImageUrl ? (
						<Image source={{uri: authorityImageUrl}} style={styles.previewImage} resizeMode="cover" />
					) : null}
					<CustomTextInput title={t('domainName')} value={domainName} onChangeText={setDomainName} />
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('initialAdministrator')}
					</ThemedText>
					<CustomTextInput
						title={t('name')}
						value={adminName}
						placeholder={t('yourNameOnPermanentRecord')}
						onChangeText={setAdminName}
					/>
					<CustomTextInput
						title={t('title')}
						value={adminTitle}
						placeholder={t('yourTitleOnPermanentRecord')}
						onChangeText={setAdminTitle}
					/>
					<FullButton
						title={t('sign')}
						icon={isSigned ? 'square-check' : 'square'}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={() => setIsSigned(!isSigned)}
					/>
				</View>

				<TouchableOpacity
					style={styles.advancedHeader}
					onPress={() => {
						toggleAdvanced();
					}}>
					<FontAwesome6 name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} color={colors.text} />
					<ThemedText type="default">{t('advanced')}</ThemedText>
				</TouchableOpacity>
				{showAdvanced ? (
					<View style={styles.section}>
						<View style={[styles.buttonHeader, styles.sectionTitle]}>
							<ThemedText type="title">{t('relays')}</ThemedText>
							<ChipButton label={t('import')} icon="circle-plus" onPress={() => console.log('Import')} />
						</View>
						{relayAddresses.map((address, index) => (
							<CustomTextInput
								key={index}
								placeholder={t('multiaddress')}
								value={address}
								onChangeText={value => updateRelayAddress(index, value)}
								icon={relayAddresses.length > 1 ? 'circle-xmark' : undefined}
								onIconPress={() => removeRelayField(index)}
							/>
						))}
						<View style={styles.buttonHeader}>
							<View />
							<ChipButton label={t('addRelay')} icon="circle-plus" onPress={addRelayField} />
						</View>
					</View>
				) : null}
			</ScrollView>

			<View style={[styles.footer, {backgroundColor: colors.card}]}>
				<FullButton
					title={t('createNetwork')}
					icon="floppy-disk"
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={() => console.log('Create network')}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	fieldLabel: {
		marginBottom: 8
	},
	input: {
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
		marginTop: 8
	},
	buttonHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center'
	},
	permanentSection: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8
	},
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16
	},
	signButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginTop: 16,
		padding: 16,
		borderRadius: 32,
		borderWidth: 1
	},
	signText: {
		fontSize: 16,
		fontWeight: '600'
	},
	advancedHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 16,
		marginBottom: 16
	},
	relayFieldContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginBottom: 8
	},
	removeButtonContainer: {
		width: 40,
		alignItems: 'center'
	},
	removeButton: {
		padding: 8
	}
});

const styles = {...globalStyles, ...localStyles};
