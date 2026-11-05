/**
 * qr-share.test.ts - Phase 64 Plan 17 (D-04, D-06). The share PNG goes to the cache dir, is shared
 * by file:// with the locked option set, and is deleted on every outcome. Comparisons of code text
 * are boolean: a failing matcher would print the credential.
 */
import * as fs from "fs";
import * as path from "path";
import jsQR from "jsqr";
import Share from "react-native-share";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { captureConsole, expectNoSecretInConsole, type ConsoleCapture } from "../__fixtures__/console-leak";
import { base64ToBytes, bytesToBase64 } from "../../utils/qr/gray-png";
import { buildShareQrPng } from "../../utils/qr/share-png";
import { QR_MAX_TEXT_CHARS } from "../../utils/qr/qr-matrix";
import { deleteSharedQrImage, QrShareError, SHARED_QR_IMAGE_FILENAME, shareJoinCodeQrImage } from "../qr-share";

interface FsMock {
	CachesDirectoryPath: string;
	writeFile: jest.Mock;
	exists: jest.Mock;
	unlink: jest.Mock;
	__fsFiles(): Array<{ path: string; encoding?: string; length: number }>;
	__resetFsMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require("../../../__mocks__/@dr.pogodin/react-native-fs.js") as FsMock;

interface DecodedPng {
	width: number;
	height: number;
	depth: number;
	colorType: number;
	data: Uint8Array;
}
interface PngjsModule {
	PNG: { sync: { read(data: Uint8Array): DecodedPng } };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as PngjsModule;

const open = jest.mocked(Share.open);
const FILE = fsMock.CachesDirectoryPath + "/" + SHARED_QR_IMAGE_FILENAME;
const NAMES = ["v2-1-member", "v2-6-members"] as const;

function windowHits(haystack: string, secret: string): number {
	let hits = 0;
	for (let i = 0; i + 16 <= secret.length; i++) if (haystack.includes(secret.slice(i, i + 16))) hits++;
	return hits;
}
async function rejection(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (e) {
		return e;
	}
	return undefined;
}
function mintOf(name: JoinCodeFixtureName): string {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES[name].text);
	if (!d.ok) throw new Error("fixture did not decode");
	return d.code.invitation;
}

let capture: ConsoleCapture;
beforeEach(() => {
	capture = captureConsole();
	fsMock.__resetFsMock();
	open.mockReset();
	open.mockImplementation(async () => ({ success: true, message: "" }));
});
afterEach(() => {
	capture.restore();
});

describe("shareJoinCodeQrImage", () => {
	it.each(NAMES)("%s: writes exactly the share PNG bytes to the cache file, and jsQR reads the code back", async (name) => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES[name];
		let written = "";
		fsMock.writeFile.mockImplementationOnce(async (_p: string, contents: string) => {
			written = contents;
		});
		await expect(shareJoinCodeQrImage({ code: text, fingerprint })).resolves.toBe("shared");
		expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
		const call = fsMock.writeFile.mock.calls[0] as [string, string, string];
		expect(call[0]).toBe(FILE);
		expect(call[2]).toBe("base64");
		expect(call[1] === bytesToBase64(buildShareQrPng(text, fingerprint))).toBe(true);
		const img = PNG.sync.read(Buffer.from(base64ToBytes(written)));
		expect([img.width, img.height, img.depth, img.colorType]).toEqual([1080, 1240, 8, 0]);
		const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: "dontInvert" });
		expect(found !== null && found.data === text).toBe(true);
	});

	it("shares by file:// with exactly the locked option set", async () => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES["v2-1-member"];
		await shareJoinCodeQrImage({ code: text, fingerprint });
		expect(open).toHaveBeenCalledTimes(1);
		const opts = open.mock.calls[0]![0] as unknown as Record<string, unknown>;
		expect(Object.keys(opts).sort()).toEqual(["excludedActivityTypes", "failOnCancel", "filename", "type", "url", "useInternalStorage"]);
		expect(opts).toEqual({
			url: "file:///mock/caches/votetorrent-join-code.png",
			type: "image/png",
			filename: "votetorrent-join-code",
			failOnCancel: false,
			useInternalStorage: true,
			excludedActivityTypes: ["com.apple.UIKit.activity.SaveToCameraRoll"],
		});
		expect((opts.url as string).startsWith("file://")).toBe(true);
		expect((opts.url as string).includes("data:")).toBe(false);
	});

	it("deletes the file once the share settles, shared or dismissed", async () => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES["v2-1-member"];
		let during = -1;
		open.mockImplementationOnce(async () => {
			during = fsMock.__fsFiles().length;
			return { success: true, message: "" };
		});
		await shareJoinCodeQrImage({ code: text, fingerprint });
		expect(during).toBe(1);
		expect(fsMock.__fsFiles()).toEqual([]);
		open.mockImplementationOnce(async () => ({ success: false, dismissedAction: true, message: "" }));
		await expect(shareJoinCodeQrImage({ code: text, fingerprint })).resolves.toBe("dismissed");
		expect(fsMock.__fsFiles()).toEqual([]);
	});

	it("a share rejection carrying the code is a typed share-failed error that holds no window of it, and the file is gone", async () => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES["v2-1-member"];
		open.mockImplementationOnce(async () => {
			throw Object.assign(new Error(text), { code: "EUNSPECIFIED" });
		});
		const err = await rejection(shareJoinCodeQrImage({ code: text, fingerprint }));
		expect(err instanceof QrShareError).toBe(true);
		const e = err as QrShareError;
		expect(e.code).toBe("share-failed");
		expect(e.name).toBe("QrShareError");
		expect(e.cause).toBeUndefined();
		expect(windowHits(String(err), text)).toBe(0);
		expect(fsMock.__fsFiles()).toEqual([]);
	});

	it("a write failure is write-failed and never opens the share sheet", async () => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES["v2-1-member"];
		fsMock.writeFile.mockImplementationOnce(async () => {
			throw new Error("disk full");
		});
		const err = await rejection(shareJoinCodeQrImage({ code: text, fingerprint }));
		expect((err as QrShareError).code).toBe("write-failed");
		expect(open).not.toHaveBeenCalled();
	});

	it("a fingerprint outside the atlas and an over-capacity text are build-failed before any write", async () => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES["v2-1-member"];
		const bad = await rejection(shareJoinCodeQrImage({ code: text, fingerprint: "zzzz zzzz zzzz zzzz" }));
		expect((bad as QrShareError).code).toBe("build-failed");
		const big = JOIN_CODE_FIXTURES["v2-6-members"].text + JOIN_CODE_FIXTURES["v2-1-member"].text;
		expect(big.length).toBeGreaterThan(QR_MAX_TEXT_CHARS);
		const over = await rejection(shareJoinCodeQrImage({ code: big, fingerprint }));
		expect((over as QrShareError).code).toBe("build-failed");
		expect(fsMock.writeFile).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it.each(NAMES)("%s: logs nothing on any outcome", async (name) => {
		const { text, fingerprint } = JOIN_CODE_FIXTURES[name];
		await shareJoinCodeQrImage({ code: text, fingerprint });
		open.mockImplementationOnce(async () => {
			throw new Error(text);
		});
		await rejection(shareJoinCodeQrImage({ code: text, fingerprint }));
		fsMock.writeFile.mockImplementationOnce(async () => {
			throw new Error(text);
		});
		await rejection(shareJoinCodeQrImage({ code: text, fingerprint }));
		await rejection(shareJoinCodeQrImage({ code: text, fingerprint: "zzzz zzzz zzzz zzzz" }));
		expect(capture.calls()).toEqual([]);
		expectNoSecretInConsole(capture, [text, mintOf(name), fingerprint, bytesToBase64(buildShareQrPng(text, fingerprint))]);
	});
});

describe("deleteSharedQrImage", () => {
	it("with no file resolves and never unlinks", async () => {
		await expect(deleteSharedQrImage()).resolves.toBeUndefined();
		expect(fsMock.unlink).not.toHaveBeenCalled();
	});

	it("removes a planted file, twice in a row", async () => {
		await fsMock.writeFile(FILE, "AAAA", "base64");
		await deleteSharedQrImage();
		expect(fsMock.__fsFiles()).toEqual([]);
		await expect(deleteSharedQrImage()).resolves.toBeUndefined();
	});

	it("a file that vanishes between exists and unlink (ENOENT) is not an error and logs nothing", async () => {
		fsMock.exists.mockImplementationOnce(async () => true);
		await expect(deleteSharedQrImage()).resolves.toBeUndefined();
		expect(fsMock.unlink).toHaveBeenCalledTimes(1);
		expect(capture.calls()).toEqual([]);
	});

	it("any other unlink failure resolves and logs the one closed token, with no argument beyond it", async () => {
		const text = JOIN_CODE_FIXTURES["v2-1-member"].text;
		await fsMock.writeFile(FILE, "AAAA", "base64");
		fsMock.unlink.mockImplementationOnce(async () => {
			throw Object.assign(new Error(text), { code: "EACCES" });
		});
		await expect(deleteSharedQrImage()).resolves.toBeUndefined();
		const calls = capture.calls();
		expect(calls).toEqual([["[voter-invite] qr-share: failed"]]);
		expectNoSecretInConsole(capture, [text]);
	});
});

describe("qr-share.ts source hygiene", () => {
	const source = fs
		.readFileSync(path.join(__dirname, "..", "qr-share.ts"), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	it.each(["data:", "Buffer", "TextEncoder", "atob(", "btoa(", ".message", "JSON.stringify", "console.log"])("has no %s", (token) => {
		expect(source.includes(token)).toBe(false);
	});
	it("imports @dr.pogodin/react-native-fs by name only", () => {
		expect(/import\s+[A-Za-z_$]+\s+from\s+'@dr\.pogodin\/react-native-fs'/.test(source)).toBe(false);
		expect(/import\s+\*\s+as\s+[A-Za-z_$]+\s+from\s+'@dr\.pogodin\/react-native-fs'/.test(source)).toBe(false);
	});
});
