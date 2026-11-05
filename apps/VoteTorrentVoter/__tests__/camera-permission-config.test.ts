/**
 * @jest-environment node
 *
 * Guards the Voter's native camera declarations for the QR join-code scanner: the Android
 * CAMERA permission and not-required camera features, the iOS purpose strings (en fallback in
 * Info.plist, en and es InfoPlist.strings), and the iOS 15.5 deployment target that the
 * VisionCamera barcode-scanner pod needs.
 *
 * The scanner decision supersedes the older "no camera" constraint for exactly these
 * declarations. The Voter still requests no microphone, storage, media or location access.
 *
 * Every file is read as text, never through the app. CAMERA_CONFIG_ROOT exists only so a red run
 * can point at a snapshot of the pre-change files: a red test file sitting in the shared
 * checkout would turn a concurrent full Voter jest run red.
 */
import * as fs from "fs";
import * as path from "path";

const APP_DIR = process.env.CAMERA_CONFIG_ROOT ?? path.resolve(__dirname, "..");

const CAMERA_USAGE_EN =
	"VoteTorrent uses the camera only to scan the QR join code from your election authority. It does not take photos or record video.";
const CAMERA_USAGE_ES =
	"VoteTorrent usa la cámara solo para escanear el código QR de acceso de tu autoridad electoral. No toma fotos ni graba video.";

const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const INFO_PLIST = "ios/VoteTorrentVoter/Info.plist";
const EN_STRINGS = "ios/VoteTorrentVoter/en.lproj/InfoPlist.strings";
const ES_STRINGS = "ios/VoteTorrentVoter/es.lproj/InfoPlist.strings";
const PODFILE = "ios/Podfile";
const PBXPROJ = "ios/VoteTorrentVoter.xcodeproj/project.pbxproj";

function read(rel: string): string {
	return fs.readFileSync(path.join(APP_DIR, rel), "utf8");
}

const stripXmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const stripCComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const stripHashComments = (s: string) =>
	s
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"))
		.join("\n");

/** Every `<tag ... />` element of the given name, as its attribute text. */
function elements(xml: string, tag: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) out.push(m[1]);
	return out;
}

const attr = (el: string, name: string): string | undefined =>
	new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(el)?.[1];

/** The value of `"key" = "value";` in an InfoPlist.strings file, or undefined. */
function stringsValue(src: string, key: string): string | undefined {
	const re = new RegExp(`^\\s*"${key}"\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*;`, "m");
	return re.exec(stripCComments(src))?.[1];
}

/** The `<string>` that follows `<key>name</key>` at the top level of an Info.plist. */
function plistString(src: string, key: string): string | undefined {
	const re = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`);
	return re.exec(src)?.[1];
}

describe("Voter Android manifest camera declarations", () => {
	const xml = () => stripXmlComments(read(MANIFEST));
	const perms = () => elements(xml(), "uses-permission");
	const features = () => elements(xml(), "uses-feature");

	it("T1: declares android.permission.CAMERA exactly once, without a remove marker", () => {
		const cams = perms().filter((p) => attr(p, "android:name") === "android.permission.CAMERA");
		expect(cams).toHaveLength(1);
		expect(attr(cams[0], "tools:node")).not.toBe("remove");
	});

	it("T2: android.hardware.camera is not required", () => {
		const f = features().filter((e) => attr(e, "android:name") === "android.hardware.camera");
		expect(f).toHaveLength(1);
		expect(attr(f[0], "android:required")).toBe("false");
	});

	it("T3: android.hardware.camera.autofocus is not required", () => {
		const f = features().filter(
			(e) => attr(e, "android:name") === "android.hardware.camera.autofocus",
		);
		expect(f).toHaveLength(1);
		expect(attr(f[0], "android:required")).toBe("false");
	});

	it("T4: no camera feature is required", () => {
		const required = features().filter(
			(e) =>
				(attr(e, "android:name") ?? "").startsWith("android.hardware.camera") &&
				attr(e, "android:required") === "true",
		);
		expect(required).toEqual([]);
	});

	it("T5: requests no microphone, storage, media or location permission", () => {
		const denied =
			/RECORD_AUDIO|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION/;
		const offenders = perms().filter(
			(p) => denied.test(attr(p, "android:name") ?? "") && attr(p, "tools:node") !== "remove",
		);
		expect(offenders).toEqual([]);
	});

	it("T6: still declares android.permission.INTERNET", () => {
		expect(perms().map((p) => attr(p, "android:name"))).toContain("android.permission.INTERNET");
	});
});

describe("Voter iOS camera purpose strings", () => {
	it("T7: Info.plist carries the English camera purpose string", () => {
		expect(plistString(read(INFO_PLIST), "NSCameraUsageDescription")).toBe(CAMERA_USAGE_EN);
	});

	it("T8: Info.plist has no microphone key", () => {
		expect(read(INFO_PLIST)).not.toContain("NSMicrophoneUsageDescription");
	});

	it("T9: Info.plist still has the Face ID key", () => {
		expect(plistString(read(INFO_PLIST), "NSFaceIDUsageDescription")).toBeTruthy();
	});

	it("T10: en.lproj InfoPlist.strings carries the English camera purpose string", () => {
		expect(stringsValue(read(EN_STRINGS), "NSCameraUsageDescription")).toBe(CAMERA_USAGE_EN);
	});

	it("T11: es.lproj InfoPlist.strings carries the Spanish camera purpose string", () => {
		expect(stringsValue(read(ES_STRINGS), "NSCameraUsageDescription")).toBe(CAMERA_USAGE_ES);
	});

	it("T12: all three camera strings are defined and name no phase number", () => {
		const values = [
			plistString(read(INFO_PLIST), "NSCameraUsageDescription"),
			stringsValue(read(EN_STRINGS), "NSCameraUsageDescription"),
			stringsValue(read(ES_STRINGS), "NSCameraUsageDescription"),
		];
		for (const v of values) {
			expect(v).toBeDefined();
			expect(v).not.toMatch(/phase\s*\d+/i);
		}
	});
});

describe("Voter iOS deployment target", () => {
	it("T13: the Podfile targets iOS 15.5, not min_ios_version_supported", () => {
		const code = stripHashComments(read(PODFILE));
		expect(code).toContain("platform :ios, '15.5'");
		const platformLines = code.split("\n").filter((l) => /^\s*platform\b/.test(l));
		expect(platformLines.some((l) => l.includes("min_ios_version_supported"))).toBe(false);
	});

	it("T14: project.pbxproj has four 15.5 deployment targets and no other value", () => {
		const lines = read(PBXPROJ)
			.split("\n")
			.filter((l) => l.includes("IPHONEOS_DEPLOYMENT_TARGET"));
		expect(lines.filter((l) => l.includes("IPHONEOS_DEPLOYMENT_TARGET = 15.5;"))).toHaveLength(4);
		expect(lines.filter((l) => !l.includes("IPHONEOS_DEPLOYMENT_TARGET = 15.5;"))).toEqual([]);
	});
});
