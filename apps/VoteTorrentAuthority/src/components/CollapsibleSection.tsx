import React, {useState} from 'react';
import {StyleSheet, TouchableOpacity, View, TextInput} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ThemedText} from './ThemedText';
import {useTheme} from '@react-navigation/native';

interface CollapsibleSectionProps {
	title: string;
	children: React.ReactNode;
	searchPlaceholder?: string;
	onSearch?: (text: string) => void;
}

export function CollapsibleSection({
	title,
	children,
	searchPlaceholder = 'Search...',
	onSearch
}: CollapsibleSectionProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [searchText, setSearchText] = useState('');
	const {colors} = useTheme();

	return (
		<View style={styles.wrapper}>
			<TouchableOpacity onPress={() => setIsExpanded(!isExpanded)}>
				<View style={styles.titleContainer}>
					<FontAwesome6
						color={colors.text}
						name={isExpanded ? 'chevron-down' : 'chevron-right'}
						size={16}
						style={styles.chevron}
					/>
					<ThemedText type="title">{title}</ThemedText>
				</View>
			</TouchableOpacity>
			{isExpanded && (
				<>
					<View style={[styles.searchContainer, {backgroundColor: colors.card}, {borderColor: colors.border}]}>
						<FontAwesome6 name="magnifying-glass" size={16} color={colors.text} />
						<TextInput
							style={[styles.searchInput, {color: colors.text}]}
							placeholder={searchPlaceholder}
							placeholderTextColor={colors.text}
							value={searchText}
							onChangeText={text => {
								setSearchText(text);
								onSearch?.(text);
							}}
						/>
					</View>
					{children}
				</>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	wrapper: {
		marginTop: 16
	},
	titleContainer: {
		flexDirection: 'row',
		alignItems: 'center'
	},
	chevron: {
		marginRight: 16
	},
	searchContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		padding: 8,
		paddingLeft: 16,
		marginTop: 8,
		marginBottom: 8,
		borderRadius: 32,
		borderWidth: 1
	},
	searchInput: {
		flex: 1,
		marginLeft: 8,
		padding: 4
	}
});
