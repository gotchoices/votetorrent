import {StyleSheet, TextInput, TextInputProps, View} from 'react-native';
import {ThemedText} from './ThemedText';
import {ChipButton} from './ChipButton';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import {useState, useEffect} from 'react';
import {useTranslation} from 'react-i18next';

/*
This component is used to easily enforce a standard input style across the app.
Key features:
 - Custom placeholder component in order to have italicised placeholder text but normal input text
 - Allows for an icon to the right of the input, usually for a trash/x icon
 - Supports the widely used Image URL input scheme with a make permanent button and info icon
*/

interface CustomTextInputProps extends TextInputProps {
	title?: string;
	isImageUrlField?: boolean;
	makePermanentPressed?: () => void;
	icon?: string;
	onIconPress?: () => void;
}

export function CustomTextInput(props: CustomTextInputProps) {
	const {colors} = useTheme() as ExtendedTheme;
	const [value, setValue] = useState(props.value || '');
	const {t} = useTranslation();

	useEffect(() => {
		if (props.value !== undefined) {
			setValue(props.value);
		}
	}, [props.value]);

	const handleChangeText = (text: string) => {
		setValue(text);
		props.onChangeText?.(text);
	};

	//spreading the props to avoid custom props from being overridden
	const {onChangeText, placeholder, ...otherProps} = props;

	return (
		<View style={styles.field}>
			{props.title && (
				<View style={styles.titleContainer}>
					<ThemedText type="defaultSemiBold">{props.title}</ThemedText>
					{props.isImageUrlField && (
						<View style={styles.imageButtons}>
							<ChipButton label={t('makePermanent')} onPress={props.makePermanentPressed} />
							<FontAwesome6 name="circle-info" size={16} color={colors.text} onPress={props.onIconPress} />
						</View>
					)}
				</View>
			)}
			<View style={styles.inputContainer}>
				{!value && (
					<ThemedText
						style={[styles.placeholder, {color: colors.textSecondary}]}
						numberOfLines={1}
						pointerEvents="none">
						{placeholder || props.title}
					</ThemedText>
				)}
				<TextInput
					value={value}
					onChangeText={handleChangeText}
					style={[styles.input, {backgroundColor: colors.card, borderColor: colors.border, color: colors.text}]}
					{...otherProps}
				/>
				{props.icon && (
					<FontAwesome6
						name={props.icon}
						size={20}
						color={colors.text}
						style={styles.icon}
						onPress={props.onIconPress}
					/>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	field: {
		marginBottom: 10
	},
	titleContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between'
	},
	imageButtons: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8
	},
	inputContainer: {
		position: 'relative',
		marginTop: 8,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between'
	},
	placeholder: {
		position: 'absolute',
		left: 14,
		top: 12,
		fontSize: 14,
		fontStyle: 'italic',
		zIndex: 1
	},
	input: {
		padding: 14,
		borderRadius: 28,
		fontSize: 14,
		borderWidth: 1,
		flex: 1
	},
	icon: {
		marginLeft: 10,
		marginRight: 6
	}
});
