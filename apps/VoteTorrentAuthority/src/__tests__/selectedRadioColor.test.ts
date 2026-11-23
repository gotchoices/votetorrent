/**
 * A selected radio is drawn in the primary colour (2026-11-23 todo). Three radios drew the selected
 * dot in `colors.accent`, which is #d9d9d9 in the light theme: on a white card the selection was
 * nearly invisible. The design prototype draws a selected radio in --primary.
 *
 * Source scan: every FontAwesome6 "circle-dot" (the selected-radio glyph) in src/ must take its
 * selected colour from `colors.primary`.
 */
import fs from "fs";
import path from "path";
import { lightTheme } from "../theme/themes";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__" || entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.tsx$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** The colour expression of each circle-dot icon element: `color={sel ? colors.X : ...}` -> X. */
function selectedColours(source: string): string[] {
	const out: string[] = [];
	const re = /<FontAwesome6\b([^>]*?)\/>/gs;
	for (const m of source.matchAll(re)) {
		const attrs = m[1];
		if (!attrs.includes('"circle-dot"')) continue;
		const colour = /color=\{\s*\w+\s*\?\s*colors\.(\w+)/.exec(attrs);
		out.push(colour ? colour[1] : "<unparsed>");
	}
	return out;
}

describe("selected radio colour", () => {
	it("controls: the matcher reads the selected colour", () => {
		expect(selectedColours('<FontAwesome6 name={s ? "circle-dot" : "circle"} size={20} color={s ? colors.accent : colors.textSecondary} />')).toEqual(["accent"]);
		expect(selectedColours('<FontAwesome6\n\tname={on ? "circle-dot" : "circle"}\n\tcolor={on ? colors.primary : colors.textSecondary}\n/>')).toEqual(["primary"]);
		expect(selectedColours('<FontAwesome6 name="check" color={colors.accent} />')).toEqual([]);
	});

	it("the light theme's accent is too faint for a selection mark (why accent is wrong here)", () => {
		expect(lightTheme.colors.accent.toLowerCase()).toBe("#d9d9d9");
	});

	it("every circle-dot in src/ takes its selected colour from colors.primary", () => {
		const found: Array<{ file: string; colour: string }> = [];
		for (const file of walk(SRC)) {
			for (const colour of selectedColours(fs.readFileSync(file, "utf8"))) {
				found.push({ file: path.relative(SRC, file), colour });
			}
		}
		expect(found.length).toBeGreaterThanOrEqual(3);
		expect(found.filter((f) => f.colour !== "primary")).toEqual([]);
	});
});
