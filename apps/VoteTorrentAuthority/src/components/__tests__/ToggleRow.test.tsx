/**
 * ToggleRow — TR-1..TR-4. The two new props (testID, accessibilityLabel) are optional and go to the
 * Switch only; without them the row renders exactly as it did before.
 */
import React from "react";
import fs from "fs";
import path from "path";
import { Switch } from "react-native";
import renderer, { act } from "react-test-renderer";
import { lightTheme } from "../../theme/themes";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../theme/themes");
		return theme;
	},
}));

import { ToggleRow } from "../ToggleRow";

async function make(el: React.ReactElement): Promise<renderer.ReactTestRenderer> {
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(el);
	});
	return r;
}

async function unmount(r: renderer.ReactTestRenderer): Promise<void> {
	await act(async () => {
		r.unmount();
	});
}

function stripKeys(node: unknown, keys: string[]): unknown {
	if (Array.isArray(node)) return node.map((n) => stripKeys(n, keys));
	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			if (keys.includes(k)) continue;
			out[k] = stripKeys(v, keys);
		}
		return out;
	}
	return node;
}

describe("ToggleRow", () => {
	it("TR-1: without the new props the Switch has no testID or accessibilityLabel and keeps its colours", async () => {
		const tr = await make(<ToggleRow label="Row" value={true} onValueChange={jest.fn()} />);
		const sw = tr.root.findByType(Switch);
		expect(sw.props.testID).toBeUndefined();
		expect(sw.props.accessibilityLabel).toBeUndefined();
		expect(sw.props.value).toBe(true);
		expect(sw.props.trackColor).toEqual({ false: lightTheme.colors.border, true: lightTheme.colors.primary });
		expect(sw.props.thumbColor).toBe(lightTheme.colors.card);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("Row");
		expect(json).toContain("600");
		await unmount(tr);
	});

	it("TR-2: a value change calls onValueChange once with the new value", async () => {
		const fn = jest.fn();
		const tr = await make(<ToggleRow label="Row" value={false} onValueChange={fn} />);
		await act(async () => {
			tr.root.findByType(Switch).props.onValueChange(true);
		});
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(true);
		await unmount(tr);
	});

	it("TR-3: with the props the Switch carries both and nothing else in the render changed", async () => {
		const a = await make(<ToggleRow label="Row" value={false} onValueChange={jest.fn()} />);
		const b = await make(
			<ToggleRow label="Row" value={false} onValueChange={jest.fn()} testID="t-id" accessibilityLabel="a-label" />,
		);
		const sw = b.root.findByType(Switch);
		expect(sw.props.testID).toBe("t-id");
		expect(sw.props.accessibilityLabel).toBe("a-label");
		const raw = JSON.stringify(b.toJSON());
		expect(raw).toContain("t-id");
		expect(raw).toContain("a-label");
		expect(JSON.stringify(stripKeys(b.toJSON(), ["testID", "accessibilityLabel"]))).toEqual(
			JSON.stringify(stripKeys(a.toJSON(), ["testID", "accessibilityLabel"])),
		);
		// The label text is not the Switch's accessibility label.
		expect(JSON.stringify(a.toJSON())).not.toContain("a-label");
		await unmount(a);
		await unmount(b);
	});

	it("TR-4: EditQuestionScreen's two call sites pass neither new prop", async () => {
		const src = fs.readFileSync(path.join(__dirname, "../../screens/ballots/EditQuestionScreen.tsx"), "utf8");
		const lines = src.split("\n");
		const starts = lines.map((l, i) => (l.includes("<ToggleRow") ? i : -1)).filter((i) => i >= 0);
		expect(starts).toHaveLength(2);
		for (const s of starts) {
			const span = lines.slice(s, s + 6).join("\n");
			expect(span).not.toMatch(/testID|accessibilityLabel/);
		}
	});
});
