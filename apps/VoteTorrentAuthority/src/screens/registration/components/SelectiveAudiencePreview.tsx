import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { DisclosedSelective, DisclosureAudience, SelectiveLeaf } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { globalStyles } from "../../../theme/styles";

/**
 * SelectiveAudiencePreview — the registrant-detail selective-tier preview
 * (D-12). Renders the raw selective set unmasked (the contrast with
 * PrivateFieldRow's masked-by-default posture is the whole design intent of
 * D-12) and, once an audience is chosen, annotates EVERY raw row as
 * Disclosed or Not-disclosed rather than hiding the undisclosed ones — the
 * delta the officer needs to see is the entire purpose of this component.
 *
 * Purely presentational: receives data + callbacks as props. No engine
 * calls, no signing, no schema access — mirrors the posture documented at
 * `DisclosurePolicySection.tsx:15-25`. `onSelectAudience` is contractually
 * the invocation of `getDisclosedSelective(electionId, registrantId,
 * audience)`, but that call belongs to the owning screen (47-20), not to
 * this component.
 *
 * Salt exclusion (D-12): `toRenderableLeaves` is the ONLY function in this
 * module that reads a raw leaf. The component body never dereferences
 * `.salt`, and never reads `disclosure.hidden` (opaque withheld-leaf digests
 * have no render surface at all).
 */

/**
 * D-12: salts are never displayed. Deliberately broad so `salt`, `Salt`,
 * `saltHex` and `fieldSalt` are all excluded from any key-enumerating
 * projection of a raw leaf.
 */
export const SALT_KEY_PATTERN = /salt/i;

export interface RenderableSelectiveField {
	name: string;
	value: string;
}

/**
 * The sole reader of a raw `SelectiveLeaf`. Builds a key-filtered projection
 * that excludes any salt-shaped key before reading `name`/`value` off it, so
 * a future consumer that enumerates keys must route through this function
 * rather than dereferencing a leaf directly.
 */
export function toRenderableLeaves(leaves: readonly SelectiveLeaf[]): RenderableSelectiveField[] {
	return leaves.map((leaf) => {
		const filtered = Object.fromEntries(
			Object.entries(leaf).filter(([key]) => !SALT_KEY_PATTERN.test(key))
		) as { name: string; value: string | number | boolean };
		return { name: filtered.name, value: String(filtered.value) };
	});
}

export interface SelectiveAudiencePreviewProps {
	/** The raw selective set. Salts are present in the DATA, never in the render. */
	leaves: readonly SelectiveLeaf[];
	selectedAudience?: DisclosureAudience;
	/** getDisclosedSelective(...) result for selectedAudience. */
	disclosure?: DisclosedSelective | null;
	onSelectAudience: (audience: DisclosureAudience) => void;
}

export function SelectiveAudiencePreview({
	leaves,
	selectedAudience,
	disclosure,
	onSelectAudience,
}: SelectiveAudiencePreviewProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	// EXACT match, deliberately NOT case-folded (47-REVIEW IN-08). Both sides
	// of this comparison originate from the SAME RegistrantSelective row:
	// `leaves` is its SelectiveDetails, and `disclosure.disclosed` is the
	// subset of those very leaves that `getDisclosedSelective` -> `setDisclose`
	// returned, carrying each leaf's `name` through verbatim. The engine's own
	// policy match is exact, so case-folding here could only ever DIVERGE from
	// it — a registrant holding two leaves differing only in case ("party" and
	// "Party") rendered BOTH as Disclosed when the engine disclosed one. On a
	// preview whose entire job is showing the officer the true disclosure
	// delta, that is a false claim about what the audience receives.
	//
	// This is NOT findDisclosureForField's situation: that helper folds case
	// because it matches an operator-typed ElectionDisclosurePolicy.FieldName
	// against a leaf name — two independently-authored strings. Here there is
	// only one string, read twice.
	//
	// Only disclosure.disclosed[].name is read — disclosure.hidden is never
	// dereferenced.
	const disclosedNames = new Set((disclosure?.disclosed ?? []).map((l) => l.name));

	const renderableFields = toRenderableLeaves(leaves);

	return (
		<View testID="selective-audience-preview" style={styles.section}>
			<ThemedText type="defaultSemiBold">
				{t("registrantDetailSelectiveAudiencePreviewTitle")}
			</ThemedText>
			<ThemedText type="small" style={{ color: colors.textSecondary }}>
				{t("registrantDetailSelectiveAudiencePreviewHint")}
			</ThemedText>

			<View style={localStyles.chipRow}>
				{/*
				 * D-12 divergence from DisclosurePolicySection's compound
				 * district-availability gate: that gate protects a WRITE that
				 * could create an unresolvable disclosure rule (T-46-04).
				 * This is a read-only preview — "this audience would receive
				 * nothing" is a legitimate, useful answer — so both chips
				 * render unconditionally with no canWrite gate (selecting an
				 * audience mutates nothing).
				 */}
				<View testID="selective-audience-chip-everyone">
					<ChipButton
						label={t("registrationPolicyAudienceEveryone")}
						icon={selectedAudience === "everyone" ? "check" : undefined}
						onPress={() => onSelectAudience("everyone")}
					/>
				</View>
				<View testID="selective-audience-chip-district">
					<ChipButton
						label={t("registrationPolicyAudienceDistrict")}
						icon={selectedAudience === "district" ? "check" : undefined}
						onPress={() => onSelectAudience("district")}
					/>
				</View>
			</View>

			{renderableFields.length === 0 ? (
				<View testID="selective-audience-preview-empty">
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrantDetailNoSelectiveTier")}
					</ThemedText>
				</View>
			) : (
				renderableFields.map((field) => {
					// disclosure === null means every row is not-disclosed;
					// disclosure === undefined means no audience chosen yet (or
					// a fetch is in flight) — no annotation rendered at all.
					const isDisclosed =
						disclosure !== undefined && disclosure !== null
							? disclosedNames.has(field.name)
							: false;

					return (
						<View
							testID={`selective-field-row-${field.name}`}
							key={field.name}
							style={localStyles.propertyRow}
						>
							<ThemedText type="defaultSemiBold" style={localStyles.propertyName}>
								{field.name}:{" "}
							</ThemedText>
							<View style={localStyles.propertyValue}>
								<ThemedText type="default">{field.value}</ThemedText>
							</View>
							{/*
							 * Annotation renders iff disclosure !== undefined, and
							 * then for EVERY row without exception — never filter
							 * the row list by disclosure. The officer is looking
							 * for the delta the policy produces; an omitted row
							 * destroys the entire purpose of D-12.
							 */}
							{disclosure !== undefined && (
								<View
									testID={`selective-field-disclosure-${field.name}`}
									style={localStyles.disclosureBadge}
								>
									{isDisclosed ? (
										<>
											<FontAwesome6 name="check" size={14} color={colors.success} />
											<ThemedText type="small">
												{t("registrantDetailSelectiveDisclosedLabel")}
											</ThemedText>
										</>
									) : (
										<>
											<FontAwesome6 name="minus" size={14} color={colors.textSecondary} />
											<ThemedText type="small" style={{ color: colors.textSecondary }}>
												{t("registrantDetailSelectiveNotDisclosedLabel")}
											</ThemedText>
										</>
									)}
								</View>
							)}
						</View>
					);
				})
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	chipRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 8,
		marginBottom: 8,
	},
	propertyRow: {
		flexDirection: "row",
		alignItems: "center",
		width: "100%",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 8,
	},
	propertyName: {
		marginRight: 4,
		textTransform: "capitalize",
	},
	propertyValue: {
		flexShrink: 1,
	},
	disclosureBadge: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
