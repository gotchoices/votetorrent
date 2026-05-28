import React, { useState } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { CustomButton } from "../../../components/CustomButton";
import { ChipButton } from "../../../components/ChipButton";
import { InfoCard } from "../../../components/InfoCard";
import { DistrictsGroupsEditor } from "./DistrictsGroupsEditor";
import { globalStyles } from "../../../theme/styles";
import type { Question } from "@votetorrent/vote-core";

interface BallotTemplateFormProps {
	/** Election context passed from route params */
	electionTitle?: string;
	electionDate?: string;
	/** Authority dropdown */
	authority: string;
	onAuthorityChange: (v: string) => void;
	/** For v1.1 a simple list of options to cycle through */
	authorityOptions?: string[];
	/** Description field */
	description: string;
	onDescriptionChange: (v: string) => void;
	/** Districts / Groups editor */
	districts: string[];
	onDistrictsChange: (next: string[]) => void;
	/** Questions list */
	questions: Question[];
	onAddQuestion: () => void;
	onEditQuestion: (code: string) => void;
	/** Footer propose action */
	onPropose: () => void;
}

/**
 * BallotTemplateForm — single shared presentational form for Figma 57:490.
 *
 * Renders both CreateBallotScreen (create/empty mode) and EditBallotScreen
 * (edit/populated mode). Decision 3: one component, two modes — no layout drift.
 *
 * Top→bottom per frame:
 *   1. Election + Date context header
 *   2. Authority dropdown (pressable row w/ chevron-down)
 *   3. Description input
 *   4. Questions list (chevron InfoCards) + ADD QUESTION chip
 *   5. Districts/Groups editor
 *   6. PROPOSE footer
 */
export function BallotTemplateForm({
	electionTitle,
	electionDate,
	authority,
	onAuthorityChange,
	authorityOptions = [],
	description,
	onDescriptionChange,
	districts,
	onDistrictsChange,
	questions,
	onAddQuestion,
	onEditQuestion,
	onPropose,
}: BallotTemplateFormProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [dropdownOpen, setDropdownOpen] = useState(false);

	const handleAuthoritySelect = (option: string) => {
		onAuthorityChange(option);
		setDropdownOpen(false);
	};

	const handleDropdownToggle = () => {
		if (authorityOptions.length > 0) {
			setDropdownOpen((prev) => !prev);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				{/* 1. Election + Date context header */}
				<View style={[styles.section, styles.contextHeader]}>
					<View style={styles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("election")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail" style={styles.contextValue}>
							{electionTitle ?? t("election")}
						</ThemedText>
					</View>
					<View style={styles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail" style={styles.contextValue}>
							{electionDate ?? t("date")}
						</ThemedText>
					</View>
				</View>

				{/* 2. Authority dropdown */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("authority")}
					</ThemedText>
					<TouchableOpacity
						onPress={handleDropdownToggle}
						style={[
							styles.dropdownRow,
							{ backgroundColor: colors.card, borderColor: colors.border },
						]}
					>
						<ThemedText
							style={[
								styles.dropdownText,
								{ color: authority ? colors.text : colors.textSecondary },
							]}
						>
							{authority || t("authorityPlaceholder")}
						</ThemedText>
						<FontAwesome6 name="chevron-down" size={16} color={colors.text} />
					</TouchableOpacity>
					{dropdownOpen && authorityOptions.length > 0 && (
						<View
							style={[
								styles.dropdownList,
								{ backgroundColor: colors.card, borderColor: colors.border },
							]}
						>
							{authorityOptions.map((option) => (
								<TouchableOpacity
									key={option}
									onPress={() => handleAuthoritySelect(option)}
									style={[
										styles.dropdownItem,
										{ borderBottomColor: colors.border },
										option === authority && { backgroundColor: colors.accent },
									]}
								>
									<ThemedText>{option}</ThemedText>
								</TouchableOpacity>
							))}
						</View>
					)}
				</View>

				{/* 3. Description input */}
				<View style={styles.section}>
					<CustomTextInput
						title={t("description")}
						value={description}
						onChangeText={onDescriptionChange}
						placeholder={t("description")}
					/>
				</View>

				{/* 4. Questions list + ADD QUESTION */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("question")}
					</ThemedText>
					{questions.map((q) => (
						<InfoCard
							key={q.code}
							title={q.title}
							additionalInfo={[
								{ label: t("code"), value: q.code },
								{ label: t("type"), value: q.type },
							]}
							icon="chevron-right"
							onPress={() => onEditQuestion(q.code)}
						/>
					))}
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addQuestion")}
							icon="circle-plus"
							onPress={onAddQuestion}
						/>
					</View>
				</View>

				{/* 5. Districts / Groups editor */}
				<View style={styles.section}>
					<DistrictsGroupsEditor districts={districts} onChange={onDistrictsChange} />
				</View>
			</ScrollView>

			{/* 6. Footer: PROPOSE */}
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					icon="paper-plane"
					onPress={onPropose}
					backgroundColor={colors.primary}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	contextHeader: {
		gap: 4,
	},
	contextRow: {
		flexDirection: "row",
		alignItems: "center",
	},
	contextValue: {
		flex: 1,
	},
	dropdownRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 14,
		borderRadius: 28,
		borderWidth: 1,
		marginTop: 8,
	},
	dropdownText: {
		fontSize: 14,
		flex: 1,
	},
	dropdownList: {
		borderRadius: 12,
		borderWidth: 1,
		marginTop: 4,
		overflow: "hidden",
	},
	dropdownItem: {
		paddingHorizontal: 14,
		paddingVertical: 12,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
});

const styles = { ...globalStyles, ...localStyles };
