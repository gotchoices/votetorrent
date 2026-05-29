import React, { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { DateField } from "../../../components/DateField";
import { ChipButton } from "../../../components/ChipButton";
import { Stepper } from "../../../components/Stepper";
import { globalStyles } from "../../../theme/styles";

/**
 * ElectionRevisionFormValue — controlled form state.
 * All dates are plain strings (no real picker — per OQ1 planner resolution).
 */
export type ElectionRevisionFormValue = {
	registrationEnds: string;
	ballotsFinal: string;
	releasingKeys: string;
	votingStarts: string;
	keyholders: string[];
	threshold: number;
	tags: string[];
	instructions: string;
};

interface ElectionRevisionFormProps {
	value: ElectionRevisionFormValue;
	onChange: (next: ElectionRevisionFormValue) => void;
	tagOptions?: string[];
}

/**
 * ElectionRevisionForm — shared presentational form component.
 *
 * Renders the "revision" portion of both New Election (Screen B) and
 * Election Revision (Screen C) — mirrors the BallotTemplateForm shared-
 * component pattern. Returns a plain <View> (not ScrollView) so each screen
 * can embed this inside its own ScrollView with its own PROPOSE footer.
 *
 * Sections (top→bottom, per Figma #15/#17):
 *   1. Timeline date-rows (registration ends, ballots final, releasing keys, voting starts)
 *   2. Key holders list + trash per row + IMPORT + ADD KEY HOLDER chips
 *   3. Threshold Policy — single Stepper row + adjacent "of M" suffix
 *   4. Tags dropdown + removable chip list
 *   5. Instructions multi-line input
 */
export function ElectionRevisionForm({
	value,
	onChange,
	tagOptions = [],
}: ElectionRevisionFormProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [tagsDropdownOpen, setTagsDropdownOpen] = useState(false);

	/** Merge a partial update and emit the new value. */
	const set = (partial: Partial<ElectionRevisionFormValue>) => {
		onChange({ ...value, ...partial });
	};

	// ── Key holders helpers ──────────────────────────────────────────────────

	const updateKeyholder = (index: number, name: string) => {
		const next = [...value.keyholders];
		next[index] = name;
		set({ keyholders: next });
	};

	const removeKeyholder = (index: number) => {
		const next = value.keyholders.filter((_, i) => i !== index);
		// Clamp threshold so it never exceeds the new length (min 1).
		const clampedThreshold = Math.max(1, Math.min(value.threshold, next.length || 1));
		set({ keyholders: next, threshold: clampedThreshold });
	};

	const addKeyholder = () => {
		set({ keyholders: [...value.keyholders, ""] });
	};

	// ── Tags helpers ─────────────────────────────────────────────────────────

	const handleTagSelect = (tag: string) => {
		if (!value.tags.includes(tag)) {
			set({ tags: [...value.tags, tag] });
		}
		setTagsDropdownOpen(false);
	};

	const removeTag = (tag: string) => {
		set({ tags: value.tags.filter((t) => t !== tag) });
	};

	const toggleTagsDropdown = () => {
		if (tagOptions.length > 0) {
			setTagsDropdownOpen((prev) => !prev);
		}
	};

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<View>
			{/* ── 1. Timeline ─────────────────────────────────────────────── */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("timeline")}
				</ThemedText>

				<DateField
					title={t("registrationEnds")}
					value={value.registrationEnds}
					onChange={(v) => set({ registrationEnds: v })}
					placeholder={t("selectDate")}
				/>
				<DateField
					title={t("ballotsFinal")}
					value={value.ballotsFinal}
					onChange={(v) => set({ ballotsFinal: v })}
					placeholder={t("selectDate")}
				/>
				<DateField
					title={t("releasingKeys")}
					value={value.releasingKeys}
					onChange={(v) => set({ releasingKeys: v })}
					placeholder={t("selectDate")}
				/>
				<DateField
					title={t("votingStarts")}
					value={value.votingStarts}
					onChange={(v) => set({ votingStarts: v })}
					placeholder={t("selectDate")}
				/>
			</View>

			{/* ── 2. Key holders ──────────────────────────────────────────── */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("keyHolders")}
				</ThemedText>

				{value.keyholders.map((name, index) => (
					<View key={index} style={styles.keyholderRow}>
						<View style={styles.keyholderInput}>
							<CustomTextInput
								value={name}
								onChangeText={(v) => updateKeyholder(index, v)}
								placeholder={t("keyholderName")}
							/>
						</View>
						<TouchableOpacity
							onPress={() => removeKeyholder(index)}
							hitSlop={8}
							style={styles.trashButton}
						>
							<FontAwesome6 name="trash" size={18} color={colors.text} />
						</TouchableOpacity>
					</View>
				))}

				<View style={styles.chipRow}>
					<ChipButton
						label={t("import")}
						icon="file-import"
						onPress={() => console.log("electionRevisionForm-import stub")}
					/>
					<ChipButton
						label={t("addKeyHolder")}
						icon="circle-plus"
						onPress={addKeyholder}
					/>
				</View>
			</View>

			{/* ── 3. Threshold Policy ─────────────────────────────────────── */}
			<View style={styles.section}>
				<View style={styles.thresholdRow}>
					<View style={styles.thresholdStepper}>
						<Stepper
							label={t("thresholdPolicy")}
							value={value.threshold}
							onChange={(n) => set({ threshold: n })}
							min={1}
							max={Math.max(1, value.keyholders.length)}
						/>
					</View>
					<ThemedText style={styles.thresholdSuffix}>
						{t("thresholdValue", { n: value.threshold, m: value.keyholders.length })}
					</ThemedText>
				</View>
			</View>

			{/* ── 4. Tags dropdown + removable chips ──────────────────────── */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("tags")}
				</ThemedText>

				<TouchableOpacity
					onPress={toggleTagsDropdown}
					style={[
						styles.dropdownRow,
						{ backgroundColor: colors.card, borderColor: colors.border },
					]}
				>
					<ThemedText style={[styles.dropdownText, { color: colors.textSecondary }]}>
						{t("tags")}
					</ThemedText>
					<FontAwesome6 name="chevron-down" size={16} color={colors.text} />
				</TouchableOpacity>

				{tagsDropdownOpen && tagOptions.length > 0 && (
					<View
						style={[
							styles.dropdownList,
							{ backgroundColor: colors.card, borderColor: colors.border },
						]}
					>
						{tagOptions.map((tag) => (
							<TouchableOpacity
								key={tag}
								onPress={() => handleTagSelect(tag)}
								style={[
									styles.dropdownItem,
									{ borderBottomColor: colors.border },
									value.tags.includes(tag) && { backgroundColor: colors.accent },
								]}
							>
								<ThemedText>{tag}</ThemedText>
							</TouchableOpacity>
						))}
					</View>
				)}

				{/* Removable chip list */}
				{value.tags.length > 0 && (
					<View style={styles.chipList}>
						{value.tags.map((tag) => (
							<View
								key={tag}
								style={[
									styles.tagChip,
									{ backgroundColor: colors.card, borderColor: colors.border },
								]}
							>
								<ThemedText type="small">{tag}</ThemedText>
								<TouchableOpacity
									onPress={() => removeTag(tag)}
									hitSlop={8}
									style={styles.removeButton}
								>
									<ThemedText type="small" style={{ color: colors.textSecondary }}>
										{"✕"}
									</ThemedText>
								</TouchableOpacity>
							</View>
						))}
					</View>
				)}
			</View>

			{/* ── 5. Instructions ─────────────────────────────────────────── */}
			<View style={styles.section}>
				<CustomTextInput
					title={t("instructionsOptional")}
					value={value.instructions}
					onChangeText={(v) => set({ instructions: v })}
					multiline
					numberOfLines={4}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	keyholderRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 4,
	},
	keyholderInput: {
		flex: 1,
	},
	trashButton: {
		padding: 6,
		marginBottom: 10,
	},
	chipRow: {
		flexDirection: "row",
		gap: 8,
		marginTop: 4,
	},
	thresholdRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	thresholdStepper: {
		flex: 0,
	},
	thresholdSuffix: {
		marginTop: 6,
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
	chipList: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 8,
	},
	tagChip: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 10,
		paddingVertical: 5,
		borderRadius: 16,
		borderWidth: 1,
		gap: 6,
	},
	removeButton: {
		padding: 2,
	},
});

const styles = { ...globalStyles, ...localStyles };
