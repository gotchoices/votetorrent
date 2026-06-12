import React, { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { computeRange } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { CustomTextInput } from "../../../components/CustomTextInput";

interface DistrictsGroupsEditorProps {
	districts: string[];
	onChange: (next: string[]) => void;
}

/**
 * DistrictsGroupsEditor — matches Figma 57:490 Districts/Groups block.
 *
 * Supports: district-code input with checkmark add affordance,
 * removable selected-district chip list with item count,
 * CLEAR ALL (trash) + ADD RANGE chips.
 */
export function DistrictsGroupsEditor({ districts, onChange }: DistrictsGroupsEditorProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [inputCode, setInputCode] = useState("");
	const [showRangeInput, setShowRangeInput] = useState(false);
	const [rangeFrom, setRangeFrom] = useState("");
	const [rangeTo, setRangeTo] = useState("");

	const handleAddCode = () => {
		const trimmed = inputCode.trim();
		if (!trimmed) return;
		// Dedupe: only add if not already present
		if (!districts.includes(trimmed)) {
			onChange([...districts, trimmed]);
		}
		setInputCode("");
	};

	const handleRemove = (code: string) => {
		onChange(districts.filter((d) => d !== code));
	};

	const handleClearAll = () => {
		onChange([]);
	};

	const handleAddRange = () => {
		onChange(computeRange(districts, rangeFrom, rangeTo));
		setRangeFrom("");
		setRangeTo("");
		setShowRangeInput(false);
	};

	// "N–M of K items" — for v1.1: from=1 (or 0 if empty), to=length, total=length
	const total = districts.length;
	const from = total > 0 ? 1 : 0;
	const to = total;

	return (
		<View style={styles.container}>
			{/* Header row: label */}
			<View style={styles.headerRow}>
				<ThemedText type="defaultSemiBold">{t("districtsGroups")}</ThemedText>
			</View>

			{/* District-code input with trailing checkmark */}
			<CustomTextInput
				value={inputCode}
				onChangeText={setInputCode}
				placeholder={t("addDistrictCode")}
				icon="check"
				onIconPress={handleAddCode}
				onSubmitEditing={handleAddCode}
			/>

			{/* Range input: two fields shown when showRangeInput is true */}
			{showRangeInput && (
				<View style={styles.rangeRow}>
					<View style={styles.rangeField}>
						<CustomTextInput
							value={rangeFrom}
							onChangeText={setRangeFrom}
							placeholder={t("from")}
							keyboardType="numeric"
						/>
					</View>
					<View style={styles.rangeField}>
						<CustomTextInput
							value={rangeTo}
							onChangeText={setRangeTo}
							placeholder={t("to")}
							keyboardType="numeric"
						/>
					</View>
					<ChipButton
						label={t("add")}
						icon="check"
						onPress={handleAddRange}
					/>
					<ChipButton
						label={t("cancel")}
						onPress={() => {
							setShowRangeInput(false);
							setRangeFrom("");
							setRangeTo("");
						}}
					/>
				</View>
			)}

			{/* Selected-district chip list (removable) */}
			{districts.length > 0 && (
				<View style={styles.chipList}>
					{districts.map((code) => (
						<View
							key={code}
							style={[styles.districtChip, { backgroundColor: colors.card, borderColor: colors.border }]}
						>
							<ThemedText type="small">{code}</ThemedText>
							<TouchableOpacity
								onPress={() => handleRemove(code)}
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

			{/* N–M of K items count */}
			<ThemedText type="small" style={[styles.countText, { color: colors.textSecondary }]}>
				{t("itemsRangeCount", { from, to, total })}
			</ThemedText>

			{/* Bottom row: CLEAR ALL + ADD RANGE */}
			<View style={styles.bottomRow}>
				<ChipButton
					label={t("clearAll")}
					icon="trash"
					onPress={handleClearAll}
				/>
				{!showRangeInput && (
					<ChipButton
						label={t("addRange")}
						icon="circle-plus"
						onPress={() => setShowRangeInput(true)}
					/>
				)}
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	container: {
		gap: 8,
	},
	headerRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 4,
	},
	rangeRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
	rangeField: {
		flex: 1,
		minWidth: 80,
	},
	chipList: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 4,
	},
	districtChip: {
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
	countText: {
		marginTop: 4,
	},
	bottomRow: {
		flexDirection: "row",
		gap: 8,
		marginTop: 4,
	},
});

const styles = { ...localStyles };
