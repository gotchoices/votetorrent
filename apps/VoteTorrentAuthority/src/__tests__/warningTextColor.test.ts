/**
 * Text is never coloured with `colors.warning` (2026-11-23 todo). `warning` (#bcb600) is a fill,
 * border and icon colour, about 2:1 on a white card; `warningText` (#806600 light) is the
 * text-safe tint the theme defines for warning-coloured labels (themes.ts).
 *
 * Source scan over src/: an object literal whose only key is `color: colors.warning` is a text
 * style (a View has no `color`), and so is a `textColor = colors.warning` assignment.
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
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

const TEXT_WARNING = [/\{\s*color:\s*colors\.warning\s*\}/g, /\btextColor\s*=\s*colors\.warning\b/g];

function hits(source: string): number {
	return TEXT_WARNING.reduce((n, re) => n + (source.match(re)?.length ?? 0), 0);
}

describe("warning-coloured text uses warningText", () => {
	it("controls", () => {
		expect(hits('<ThemedText style={{ color: colors.warning }}>')).toBe(1);
		expect(hits("textColor = colors.warning;")).toBe(1);
		expect(hits("{icon: 'rotate', color: colors.warning, textColor: colors.warningText}")).toBe(0);
		expect(hits("<FontAwesome6 color={colors.warning} />")).toBe(0);
		expect(hits("{ color: colors.warningText }")).toBe(0);
	});

	it("the two tokens differ in the light theme (why the distinction matters)", () => {
		expect(lightTheme.colors.warning).not.toBe(lightTheme.colors.warningText);
	});

	it("no text in src/ is coloured with colors.warning", () => {
		const offenders = walk(SRC)
			.map((file) => ({ file: path.relative(SRC, file), n: hits(fs.readFileSync(file, "utf8")) }))
			.filter((f) => f.n > 0);
		expect(offenders).toEqual([]);
	});

	it("OfficerCard's warning status text uses warningText", () => {
		const src = fs.readFileSync(path.join(SRC, "screens/authorities/components/OfficerCard.tsx"), "utf8");
		expect(src).toMatch(/tone === "warning"\s*\?\s*colors\.warningText/);
	});
});
