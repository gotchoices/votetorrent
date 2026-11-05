/**
 * RestBridgeConfigCard — Phase 62 Plan 25 (D-29, 62-UI-SPEC Surface 1) proofs: K1-K6, KG1-KG3.
 * Mirrors `PeerTransportStatusCard.test.tsx`'s sentinel palette / flattened-style geometry helpers.
 */

import fs from "fs";
import path from "path";
import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key + "|" + Object.entries(options).map(([k, v]) => k + "=" + String(v)).join(",")
				: key,
	}),
}));

const SENTINEL_COLORS = {
	accent: "#ACCENT0",
	success: "#SUCCES0",
	error: "#ERROR00",
	warning: "#WARN000",
	textSecondary: "#MUTED00",
	card: "#CARD000",
	text: "#TEXT000",
	dark: "#DARK000",
	light: "#LIGHT00",
	primary: "#PRIMAR0",
	border: "#BORDER0",
};

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: SENTINEL_COLORS }),
}));

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RestBridgeConfigCard } = require("../RestBridgeConfigCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StyleSheet } = require("react-native");

function renderCard(tree: React.ReactElement): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(tree);
	});
	return tr;
}

function findByTestID(root: renderer.ReactTestInstance, id: string): renderer.ReactTestInstance[] {
	return root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
}

function flatten(style: unknown): Record<string, unknown> {
	const flat = StyleSheet.flatten(style);
	return flat ?? {};
}

function findTextInput(root: renderer.ReactTestInstance): renderer.ReactTestInstance {
	return root.findAll((node) => typeof node.type === "string" && node.props.testID === "registration-bridge-config-url")[0]!;
}

describe("RestBridgeConfigCard — K1 loaded, no URL", () => {
	it("renders heading, URL field and Save; Save disabled while draft is empty", () => {
		const onSave = jest.fn();
		const tr = renderCard(<RestBridgeConfigCard loading={false} savedUrl={null} onSave={onSave} />);
		expect(findByTestID(tr.root, "rest-bridge-config-card")).toHaveLength(1);
		const input = findTextInput(tr.root);
		expect(input.props.title).toBe("registrationBridgeConfigUrlLabel");
		// CustomTextInput draws the placeholder as its own italic overlay Text, not a `placeholder`
		// prop on the native TextInput (see CustomTextInput.tsx) — assert it renders in the tree.
		expect(JSON.stringify(tr.toJSON())).toContain("registrationBridgeConfigUrlPlaceholder");
		const saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
		const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(true);
	});
});

describe("RestBridgeConfigCard — K2 invalid draft", () => {
	it("shows the invalid message for http, hides it and enables Save for a valid https draft, and onSave fires once with the trimmed draft", () => {
		const onSave = jest.fn();
		const tr = renderCard(<RestBridgeConfigCard loading={false} savedUrl={null} onSave={onSave} />);
		const input = findTextInput(tr.root);

		renderer.act(() => {
			input.props.onChangeText("http://x");
		});
		expect(findByTestID(tr.root, "registration-bridge-config-invalid")).toHaveLength(1);
		let saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
		let button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(true);

		renderer.act(() => {
			input.props.onChangeText("  https://bridge.example/intake  ");
		});
		expect(findByTestID(tr.root, "registration-bridge-config-invalid")).toHaveLength(0);
		saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
		button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(false);

		renderer.act(() => {
			button.props.onPress();
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave).toHaveBeenCalledWith("https://bridge.example/intake");
	});
});

describe("RestBridgeConfigCard — K3 notices", () => {
	it("'saved' renders SavedConfirm; 'save-error' renders SaveError via InlineError; 'co-sign-required' renders the co-sign line with field+Save disabled and no saved/error text", () => {
		const trSaved = renderCard(<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" notice="saved" onSave={jest.fn()} />);
		expect(JSON.stringify(trSaved.toJSON())).toContain("registrationBridgeConfigSavedConfirm");

		const trError = renderCard(<RestBridgeConfigCard loading={false} savedUrl={null} notice="save-error" onSave={jest.fn()} />);
		expect(JSON.stringify(trError.toJSON())).toContain("registrationBridgeConfigSaveError");

		// Seeded with an ALREADY-VALID saved URL — so the co-sign-required disable below is
		// provably attributable to the notice itself, never masked by the empty-draft "invalid
		// URL" disable path (a prior version of this test seeded `savedUrl={null}` here, which
		// left Save disabled for the WRONG reason and let m3 — dropping the notice check from
		// Save's disabled condition — pass vacuously).
		const trCoSign = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" notice="co-sign-required" onSave={jest.fn()} />,
		);
		expect(findByTestID(trCoSign.root, "registration-bridge-config-co-sign")).toHaveLength(1);
		expect(JSON.stringify(trCoSign.toJSON())).toContain("registrationBridgeConfigCoSignRequired");
		expect(JSON.stringify(trCoSign.toJSON())).not.toContain("registrationBridgeConfigSavedConfirm");
		expect(JSON.stringify(trCoSign.toJSON())).not.toContain("registrationBridgeConfigSaveError");

		const input = findTextInput(trCoSign.root);
		expect(input.props.editable).toBe(false);
		expect(input.props.value).toBe("https://bridge.example"); // a saveable draft, not an empty one
		const saveWrapper = findByTestID(trCoSign.root, "registration-bridge-config-save")[0]!;
		const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(true);
	});
});

describe("RestBridgeConfigCard — K4 gating", () => {
	it("disabled/loading keep the field and Save present but disabled; submitting disables Save", () => {
		for (const props of [{ disabled: true }, { loading: true }]) {
			const tr = renderCard(
				<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" onSave={jest.fn()} {...props} />,
			);
			const input = findTextInput(tr.root);
			expect(input.props.editable).toBe(false);
			const saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
			const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
			expect(button.props.disabled).toBe(true);
		}

		const trSubmitting = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" submitting onSave={jest.fn()} />,
		);
		const saveWrapper = findByTestID(trSubmitting.root, "registration-bridge-config-save")[0]!;
		const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(true);
	});
});

describe("RestBridgeConfigCard — K5 seeding", () => {
	it("the field shows the new savedUrl when it changes from null to an https URL", () => {
		const tr = renderCard(<RestBridgeConfigCard loading savedUrl={null} onSave={jest.fn()} />);
		expect(findTextInput(tr.root).props.value).toBe("");

		renderer.act(() => {
			tr.update(<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example/intake" onSave={jest.fn()} />);
		});
		expect(findTextInput(tr.root).props.value).toBe("https://bridge.example/intake");
	});
});

describe("RestBridgeConfigCard — K6 colours", () => {
	it("Save uses colors.accent; the co-sign line uses textSecondary; invalid/save-error use colors.error; no success colour appears anywhere", () => {
		const tr = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" onSave={jest.fn()} />,
		);
		const saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
		const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
		expect(flatten(button.props.style).backgroundColor).toBe(SENTINEL_COLORS.accent);

		const input = findTextInput(tr.root);
		renderer.act(() => {
			input.props.onChangeText("http://x");
		});
		const invalidText = findByTestID(tr.root, "registration-bridge-config-invalid")[0]!;
		const invalidTextNode = invalidText.findAllByType(require("react-native").Text)[0]!;
		expect(flatten(invalidTextNode.props.style).color).toBe(SENTINEL_COLORS.error);

		const trCoSign = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl={null} notice="co-sign-required" onSave={jest.fn()} />,
		);
		const coSignNode = findByTestID(trCoSign.root, "registration-bridge-config-co-sign")[0]!;
		expect(flatten(coSignNode.props.style).color).toBe(SENTINEL_COLORS.textSecondary);

		const allTrees = [tr, trCoSign].map((t) => JSON.stringify(t.toJSON()));
		for (const s of allTrees) {
			expect(s).not.toContain(SENTINEL_COLORS.success);
		}
	});
});

describe("RestBridgeConfigCard — KG1 wrap", () => {
	it("no message Text has numberOfLines/ellipsizeMode, and no ancestor up to the card root fixes height/maxHeight/overflow hidden or width/maxWidth", () => {
		const tr = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl={null} notice="co-sign-required" onSave={jest.fn()} />,
		);
		const input = findTextInput(tr.root);
		renderer.act(() => {
			input.props.onChangeText("http://x");
		});

		for (const id of ["registration-bridge-config-invalid", "registration-bridge-config-co-sign"]) {
			const nodes = findByTestID(tr.root, id);
			if (nodes.length === 0) continue;
			for (const n of nodes) {
				expect(n.props.numberOfLines).toBeUndefined();
				expect(n.props.ellipsizeMode).toBeUndefined();
			}
		}

		const root = findByTestID(tr.root, "rest-bridge-config-card")[0]!;
		const descendants = root.findAll((node) => typeof node.type === "string");
		for (const node of [root, ...descendants]) {
			const flat = flatten(node.props.style);
			expect(flat.height).toBeUndefined();
			expect(flat.maxHeight).toBeUndefined();
			expect(flat.overflow).not.toBe("hidden");
			expect(flat.width).toBeUndefined();
			expect(flat.maxWidth).toBeUndefined();
		}
	});
});

describe("RestBridgeConfigCard — KG2 bound", () => {
	it("the ES co-sign string exceeds the 296dp content width (wrapping is required)", () => {
		// Pulled from the i18n catalog directly (not mocked t()) — the real ES copy.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const i18n = fs.readFileSync(path.resolve(__dirname, "../../../../i18n/index.ts"), "utf8");
		const esMatch = i18n.match(/registrationBridgeConfigCoSignRequired:\s*\n?\s*'([^']+)'/g);
		expect(esMatch).toBeTruthy();
		// Second occurrence in file order is the ES block (EN appears first).
		const quoted = [...i18n.matchAll(/registrationBridgeConfigCoSignRequired:\s*\n?\s*'([^']+)'/g)].map((m) => m[1]!);
		expect(quoted.length).toBeGreaterThanOrEqual(2);
		const esString = quoted[1]!;
		const FONT_SIZE = 16; // ThemedText type="default"
		const estimate = esString.length * FONT_SIZE * 0.6;
		const CONTENT_WIDTH = 360 - 2 * 16 - 2 * 16;
		// eslint-disable-next-line no-console
		console.log("KG2 bound:", { esLength: esString.length, estimate, CONTENT_WIDTH });
		expect(estimate).toBeGreaterThan(CONTENT_WIDTH);
	});
});

describe("RestBridgeConfigCard — KG3 field", () => {
	it("the TextInput has autoCapitalize none, autoCorrect false, keyboardType url, maxLength 2048, no multiline, no width/maxWidth; Save wrapper height is at least 36", () => {
		const tr = renderCard(
			<RestBridgeConfigCard loading={false} savedUrl="https://bridge.example" onSave={jest.fn()} />,
		);
		const input = findTextInput(tr.root);
		expect(input.props.autoCapitalize).toBe("none");
		expect(input.props.autoCorrect).toBe(false);
		expect(input.props.keyboardType).toBe("url");
		expect(input.props.maxLength).toBe(2048);
		expect(input.props.multiline).toBeUndefined();
		const flat = flatten(input.props.style);
		expect(flat.width).toBeUndefined();
		expect(flat.maxWidth).toBeUndefined();

		const saveWrapper = findByTestID(tr.root, "registration-bridge-config-save")[0]!;
		const wrapperFlat = flatten(saveWrapper.props.style);
		if (typeof wrapperFlat.height === "number") {
			expect(wrapperFlat.height).toBeGreaterThanOrEqual(36);
		}
	});
});

describe("RestBridgeConfigCard — source hygiene", () => {
	it('contains registrationBridgeConfigCoSignRequired exactly once and no numberOfLines/success-colour/overflow-hidden literal', () => {
		const source = fs.readFileSync(path.resolve(__dirname, "../RestBridgeConfigCard.tsx"), "utf8");
		const stripped = source.replace(/\/\/.*$/gm, "");
		expect((stripped.match(/registrationBridgeConfigCoSignRequired/g) || []).length).toBe(1);
		expect(stripped).not.toMatch(/numberOfLines/);
		expect(stripped).not.toMatch(/colors\.success/);
		expect(stripped).not.toMatch(/overflow/);
	});
});
