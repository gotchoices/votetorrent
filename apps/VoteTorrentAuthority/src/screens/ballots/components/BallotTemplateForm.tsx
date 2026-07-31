import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { ChipButton } from "../../../components/ChipButton";
import { InfoCard } from "../../../components/InfoCard";
import { DistrictsGroupsEditor } from "./DistrictsGroupsEditor";
import { globalStyles } from "../../../theme/styles";
import type { Question } from "@votetorrent/vote-core";

interface BallotTemplateFormProps {
	/** Election context passed from route params */
	electionTitle?: string;
	electionDate?: string;
	/** Authority dropdown — `authority` is the stored authority id */
	authority: string;
	onAuthorityChange: (v: string) => void;
	/** Real authorities to choose from: display `name`, store `id` */
	authorityOptions?: Array<{ id: string; name: string }>;
	/** Description field */
	description: string;
	onDescriptionChange: (v: string) => void;
	/** Districts / Groups editor */
	districts: string[];
	onDistrictsChange: (next: string[]) => void;
	/** Questions list */
	questions: Question[];
	onAddQuestion?: () => void;
	onEditQuestion?: (code: string) => void;
	/**
	 * D-05: when true all edit controls are disabled (ballot is locked for confirmation).
	 * The form renders in read-only mode — no authority/description/question edits.
	 */
	disabled?: boolean;
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
 *
 * NOTE: The PROPOSE footer is owned by the SCREEN (not this component)
 * so each screen can wire its own handler. Both screens render an identical
 * footer, keeping them in sync.
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
	disabled = false,
}: BallotTemplateFormProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	const [dropdownOpen, setDropdownOpen] = useState(false);

	// `authority` stores the selected authority id; show its name in the row.
	const selectedName = authorityOptions.find((o) => o.id === authority)?.name ?? "";

	// A ballot carries its own AuthorityId (Ballot.MutationValid requires a 'ceb'
	// signature from an admin of *that* authority, independent of the election's
	// authority), so the field always exists in the model. But when the network
	// has exactly one authority there is nothing to choose — collapse the picker
	// to a read-only label rather than making the operator open a one-item list.
	const soleOption = authorityOptions.length === 1 ? authorityOptions[0] : undefined;

	// Committing the value matters, not just displaying it: a collapsed label
	// showing a name while the draft still holds "" would fail AuthorityIdValid
	// at propose time.
	useEffect(() => {
		if (soleOption && !authority && !disabled) {
			onAuthorityChange(soleOption.id);
		}
	}, [soleOption, authority, disabled, onAuthorityChange]);

	const handleAuthoritySelect = (optionId: string) => {
		onAuthorityChange(optionId);
		setDropdownOpen(false);
	};

	const handleDropdownToggle = () => {
		if (authorityOptions.length > 0 && !disabled) {
			setDropdownOpen((prev) => !prev);
		}
	};

	return (
		<ScrollView
			style={[styles.container, { backgroundColor: colors.background }]}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
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
				{soleOption ? (
					<View
						style={[
							styles.dropdownRow,
							{ backgroundColor: colors.card, borderColor: colors.border },
						]}
					>
						<ThemedText style={[styles.dropdownText, { color: colors.text }]}>
							{soleOption.name}
						</ThemedText>
					</View>
				) : (
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
								{ color: selectedName ? colors.text : colors.textSecondary },
							]}
						>
							{selectedName || t("authorityPlaceholder")}
						</ThemedText>
						<FontAwesome6 name="chevron-down" size={16} color={colors.text} />
					</TouchableOpacity>
				)}
				{dropdownOpen && !soleOption && authorityOptions.length > 0 && (
					<View
						style={[
							styles.dropdownList,
							{ backgroundColor: colors.card, borderColor: colors.border },
						]}
					>
						{authorityOptions.map((option) => (
							<TouchableOpacity
								key={option.id}
								onPress={() => handleAuthoritySelect(option.id)}
								style={[
									styles.dropdownItem,
									{ borderBottomColor: colors.border },
									option.id === authority && { backgroundColor: colors.accent },
								]}
							>
								<ThemedText>{option.name}</ThemedText>
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
					onChangeText={disabled ? undefined : onDescriptionChange}
					placeholder={t("description")}
					editable={!disabled}
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
						onPress={disabled || !onEditQuestion ? undefined : () => onEditQuestion(q.code)}
					/>
				))}
				{!disabled && onAddQuestion && (
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addQuestion")}
							icon="circle-plus"
							onPress={onAddQuestion}
						/>
					</View>
				)}
			</View>

			{/* 5. Districts / Groups editor */}
			<View style={styles.section}>
				<DistrictsGroupsEditor districts={districts} onChange={onDistrictsChange} />
			</View>
		</ScrollView>
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

// globalStyles provides: container, section, sectionTitle, footer
const styles = { ...globalStyles, ...localStyles };
