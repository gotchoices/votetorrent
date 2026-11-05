import {StyleSheet, TextInput, TextInputProps, View} from 'react-native';
import {ThemedText} from './ThemedText';
import {ChipButton} from './ChipButton';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import {useState, useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {useSettings} from '../providers/SettingsProvider';

/*
This component is used to easily enforce a standard input style across the app.
Key features:
 - Custom placeholder component in order to have italicised placeholder text but normal input text
 - Allows for an icon to the right of the input, usually for a trash/x icon
 - Supports the widely used Image URL input scheme with a make permanent button and info icon,
   plus an optional status line under the input (see hooks/useMediaPin)
*/

interface CustomTextInputProps extends TextInputProps {
	title?: string;
	isImageUrlField?: boolean;
	makePermanentPressed?: () => void;
	/** Disables the Make Permanent chip (e.g. empty URL, or a pin already running). */
	makePermanentDisabled?: boolean;
	/** Status of the last Make Permanent for this field's current value. */
	permanentStatus?: {label: string; tone: 'muted' | 'success' | 'error'};
	icon?: string;
	onIconPress?: () => void;
}

export function CustomTextInput(props: CustomTextInputProps) {
	const {colors} = useTheme() as ExtendedTheme;
	const {showHelpIcons} = useSettings();
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
	const {onChangeText, placeholder, makePermanentDisabled, permanentStatus, ...otherProps} = props;
	const statusColor =
		permanentStatus?.tone === 'error'
			? colors.error
			: permanentStatus?.tone === 'success'
				? colors.primary
				: colors.textSecondary;

	return (
		<View style={styles.field}>
			{props.title && (
				<View style={styles.titleContainer}>
					<ThemedText type="defaultSemiBold">{props.title}</ThemedText>
					{props.isImageUrlField && (
						<View style={styles.imageButtons}>
							<ChipButton
								label={t('makePermanent')}
								onPress={props.makePermanentPressed}
								disabled={makePermanentDisabled}
							/>
							{showHelpIcons && <FontAwesome6 name="circle-info" size={16} color={colors.text} onPress={props.onIconPress} />}
						</View>
					)}
				</View>
			)}
			<View style={styles.inputContainer}>
				{!value && (
					// pointerEvents="none" is NOT honored by the underlying Android TextView (it is only
					// implemented for View-derived native components), so a bare <Text> here is touch-opaque
					// under its rendered glyphs and swallows taps meant for the TextInput below it -- the
					// dead zone spans exactly the placeholder string's width. Wrapping in a plain View
					// (which DOES implement pointerEvents on Android) fixes this; the View absorbs the
					// absolute positioning and the "none" behaviour, while ThemedText only carries the text.
					<View style={styles.placeholder} pointerEvents="none">
						<ThemedText style={{color: colors.textSecondary, fontSize: 14, fontStyle: 'italic'}} numberOfLines={1}>
							{placeholder || props.title}
						</ThemedText>
					</View>
				)}
				<TextInput
					// URL fields: no auto-capitalization/correction — a keyboard-capitalized "Http://"
					// is refused by Android's networking. Callers can still override via otherProps.
					{...(props.isImageUrlField
						? {autoCapitalize: 'none' as const, autoCorrect: false, keyboardType: 'url' as const}
						: {})}
					// The placeholder is drawn by a separate overlay (for italics), so the native
					// input has no hint of its own — expose the field name and placeholder to
					// screen readers explicitly. Callers can still override via otherProps.
					accessibilityLabel={props.title ?? placeholder}
					accessibilityHint={props.title ? placeholder : undefined}
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
			{permanentStatus && (
				<ThemedText
					testID="custom-text-input-permanent-status"
					accessibilityLiveRegion="polite"
					style={[styles.status, {color: statusColor}]}>
					{permanentStatus.label}
				</ThemedText>
			)}
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
	},
	status: {
		marginTop: 6,
		marginLeft: 14,
		fontSize: 13
	}
});
