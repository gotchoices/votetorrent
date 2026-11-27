/**
 * Guards the react-native-screens feature flag that keeps native-stack screens from losing one
 * header height of layout after the keyboard opens or closes (see rnscreens-flags.js for the cause).
 * Two halves: the flag module really sets the flag, and index.js loads it before the App module.
 */
import * as fs from "fs";
import * as path from "path";

const APP_ROOT = path.join(__dirname, "..");

describe("rnscreens-flags", () => {
	it("turns off androidResetScreenShadowStateOnOrientationChangeEnabled", () => {
		jest.isolateModules(() => {
			require("../rnscreens-flags");
			const { featureFlags } = require("react-native-screens");
			expect(
				featureFlags.experiment.androidResetScreenShadowStateOnOrientationChangeEnabled,
			).toBe(false);
		});
	});

	it("index.js imports the flag module before the App module (so it runs before any Screen renders)", () => {
		const src = fs.readFileSync(path.join(APP_ROOT, "index.js"), "utf8");
		const code = src
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		const flagsAt = code.search(/^import\s+['"]\.\/rnscreens-flags['"];?/m);
		const appAt = code.search(/^import\s+App\s+from\s+['"]\.\/App['"];?/m);
		expect(flagsAt).toBeGreaterThanOrEqual(0);
		expect(appAt).toBeGreaterThan(flagsAt);
	});
});
