import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";

// Phase 9 plan 09-02 (ELECUI-03) — 4-step Create Election wizard.
// D-01: multi-step wizard, NEXT/BACK between steps.
// D-02: step list = Basics → Timeline → Keyholders → Review.
// D-03: PROPOSE = stub (console.log + navigation.goBack); no mock-state mutation.
// D-04: per-section Edit chips on Review jump back to that step with state preserved.
// D-17: en-only i18n; Spanish deferred to Phase 11.
// D-18: no real engine wiring; keyholder candidates are a hardcoded mock list.

type WizardStep = "basics" | "timeline" | "keyholders" | "review";

const WIZARD_STEPS: WizardStep[] = ["basics", "timeline", "keyholders", "review"];

// Mock keyholder candidate users (D-18 — hardcoded list per planner discretion bullet).
// MockUserEngine.list() integration deferred; this seed is sufficient for v1.1 UI parity.
const MOCK_KEYHOLDER_CANDIDATES: Array<{ id: string; name: string }> = [
	{ id: "user-mock-1", name: "Jane Doe" },
	{ id: "user-mock-2", name: "John Smith" },
	{ id: "user-mock-3", name: "Alex Rivera" },
	{ id: "user-mock-4", name: "Sam Patel" },
];

export function CreateElectionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	// --- All wizard state is declared at screen scope, BEFORE any conditional
	// per-step render, so data is preserved across step navigation (D-04).
	// The acceptance criteria verify-grep requires the explicit identifiers
	// `electionName` and `electionDescription` to live at top-level scope.
	const [step, setStep] = useState<WizardStep>("basics");
	const [electionName, setElectionName] = useState("");
	const [electionDescription, setElectionDescription] = useState("");
	const [tagsInput, setTagsInput] = useState("");
	const [registrationDeadline, setRegistrationDeadline] = useState("");
	const [votingStartDate, setVotingStartDate] = useState("");
	const [votingEndDate, setVotingEndDate] = useState("");
	const [revisionDeadline, setRevisionDeadline] = useState("");
	const [keyholders, setKeyholders] = useState<string[]>([]);

	// Tags rendered/stored as comma-separated. We split on render where needed.
	const tags = tagsInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const currentStepIndex = WIZARD_STEPS.indexOf(step);

	// Step navigation (D-04 — data is preserved by virtue of state living above).
	const handleNext = () => {
		const next = WIZARD_STEPS[currentStepIndex + 1];
		if (next) {
			setStep(next);
		}
	};

	const handleBack = () => {
		const prev = WIZARD_STEPS[currentStepIndex - 1];
		if (prev) {
			setStep(prev);
		}
	};

	// D-03 stub: log payload + goBack. Matches Phase 8 D-04 / D-15 convention
	// (verbatim shape mirrors ReplaceAdminScreen.tsx:114-121).
	const handlePropose = () => {
		console.log("createElection-propose stub", {
			electionName,
			electionDescription,
			tags,
			registrationDeadline,
			votingStartDate,
			votingEndDate,
			revisionDeadline,
			keyholders,
		});
		navigation.goBack();
	};

	const toggleKeyholder = (id: string) => {
		setKeyholders((prev) =>
			prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]
		);
	};

	// Step indicator: 4 horizontal dots (planner discretion — simplest
	// Figma-compatible affordance). Current dot uses colors.primary; others use
	// colors.muted.
	const renderStepIndicator = () => (
		<View style={styles.stepIndicator}>
			{WIZARD_STEPS.map((s, i) => (
				<View
					key={s}
					style={[
						styles.stepDot,
						{
							backgroundColor: i === currentStepIndex ? colors.primary : colors.muted,
						},
					]}
				/>
			))}
			<ThemedText type="small" style={styles.stepLabel}>
				{`${t("step")} ${currentStepIndex + 1} / ${WIZARD_STEPS.length}`}
			</ThemedText>
		</View>
	);

	const renderBasicsStep = () => (
		<View style={styles.section}>
			<ThemedText type="title" style={styles.sectionTitle}>
				{t("basics")}
			</ThemedText>
			<CustomTextInput
				title={t("name")}
				value={electionName}
				onChangeText={setElectionName}
			/>
			<CustomTextInput
				title={t("description")}
				value={electionDescription}
				onChangeText={setElectionDescription}
			/>
			<CustomTextInput
				title={t("tags")}
				value={tagsInput}
				onChangeText={setTagsInput}
				placeholder={t("addTag")}
			/>
		</View>
	);

	const renderTimelineStep = () => (
		<View style={styles.section}>
			<ThemedText type="title" style={styles.sectionTitle}>
				{t("timeline")}
			</ThemedText>
			<CustomTextInput
				title={t("registrationDeadline")}
				value={registrationDeadline}
				onChangeText={setRegistrationDeadline}
			/>
			<CustomTextInput
				title={t("votingOpens")}
				value={votingStartDate}
				onChangeText={setVotingStartDate}
			/>
			<CustomTextInput
				title={t("votingCloses")}
				value={votingEndDate}
				onChangeText={setVotingEndDate}
			/>
			<CustomTextInput
				title={t("revisionDeadline")}
				value={revisionDeadline}
				onChangeText={setRevisionDeadline}
			/>
		</View>
	);

	const renderKeyholdersStep = () => (
		<View style={styles.section}>
			<ThemedText type="title" style={styles.sectionTitle}>
				{t("keyholders")}
			</ThemedText>
			<ThemedText type="default" style={styles.helperText}>
				{t("selectKeyholders")}
			</ThemedText>
			{MOCK_KEYHOLDER_CANDIDATES.map((candidate) => {
				const selected = keyholders.includes(candidate.id);
				return (
					<InfoCard
						key={candidate.id}
						title={candidate.name}
						subtitle={candidate.id}
						icon={selected ? "circle-check" : "circle"}
						onPress={() => toggleKeyholder(candidate.id)}
					/>
				);
			})}
			{keyholders.length === 0 && (
				<ThemedText type="small" style={styles.helperText}>
					{t("noKeyholdersSelected")}
				</ThemedText>
			)}
		</View>
	);

	const renderReviewSection = (
		titleKey: string,
		jumpTo: WizardStep,
		rows: Array<{ label: string; value: string }>
	) => (
		<View style={styles.section}>
			<View style={styles.sectionHeader}>
				<ThemedText type="title">{t(titleKey)}</ThemedText>
				<ChipButton label={t("edit")} icon="pen" onPress={() => setStep(jumpTo)} />
			</View>
			{rows.map((row) => (
				<View key={row.label} style={styles.reviewRow}>
					<ThemedText type="defaultSemiBold">{row.label}: </ThemedText>
					<ThemedText type="default">{row.value || "—"}</ThemedText>
				</View>
			))}
		</View>
	);

	const renderReviewStep = () => {
		const keyholderNames = keyholders
			.map((id) => MOCK_KEYHOLDER_CANDIDATES.find((c) => c.id === id)?.name ?? id)
			.join(", ");
		return (
			<>
				{renderReviewSection("basics", "basics", [
					{ label: t("name"), value: electionName },
					{ label: t("description"), value: electionDescription },
					{ label: t("tags"), value: tags.join(", ") },
				])}
				{renderReviewSection("timeline", "timeline", [
					{ label: t("registrationDeadline"), value: registrationDeadline },
					{ label: t("votingOpens"), value: votingStartDate },
					{ label: t("votingCloses"), value: votingEndDate },
					{ label: t("revisionDeadline"), value: revisionDeadline },
				])}
				{renderReviewSection("keyholders", "keyholders", [
					{ label: t("keyholders"), value: keyholderNames },
				])}
			</>
		);
	};

	// Conditional body render. All useState declarations (above) live BEFORE
	// this `switch` over the wizard step — verified by the awk gate in the
	// plan's automated verify (D-04 state-preservation requirement).
	const renderBody = () => {
		switch (step) {
			case "basics":
				return renderBasicsStep();
			case "timeline":
				return renderTimelineStep();
			case "keyholders":
				return renderKeyholdersStep();
			case "review":
				return renderReviewStep();
			default:
				return null;
		}
	};

	const onPrimaryPress = step === "review" ? handlePropose : handleNext;
	const showBack = step !== "basics";

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				{renderStepIndicator()}
				{renderBody()}
			</ScrollView>

			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<View style={styles.footerRow}>
					{showBack ? (
						<View style={styles.footerSlot}>
							<CustomButton
								title={t("back")}
								icon="arrow-left"
								onPress={handleBack}
								size="thin"
								backgroundColor={colors.accent}
								flex
							/>
						</View>
					) : (
						<View style={styles.footerSlot} />
					)}
					<View style={styles.footerSlot}>
						<CustomButton
							title={step === "review" ? t("propose") : t("next")}
							icon={step === "review" ? "floppy-disk" : "arrow-right"}
							onPress={onPrimaryPress}
							backgroundColor={step === "review" ? colors.success : colors.primary}
							forceDarkText={true}
							flex
						/>
					</View>
				</View>
			</View>
		</View>
	);
}

export default CreateElectionScreen;

const localStyles = StyleSheet.create({
	stepIndicator: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		marginBottom: 16,
	},
	stepDot: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	stepLabel: {
		marginLeft: 12,
	},
	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 12,
	},
	reviewRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		marginVertical: 2,
		flexWrap: "wrap",
	},
	helperText: {
		marginVertical: 8,
	},
	footerRow: {
		flexDirection: "row",
		gap: 12,
	},
	footerSlot: {
		flex: 1,
	},
});
const styles = { ...globalStyles, ...localStyles };
