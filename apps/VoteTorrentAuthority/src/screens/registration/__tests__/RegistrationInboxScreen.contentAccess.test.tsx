/**
 * RegistrationInboxScreen.contentAccess.test.tsx — 62-27 (D-49): an unread sealed request is
 * listed with its reason directly under its row instead of as a nameless row. It mirrors the
 * existing inbox suite's mocks (`@react-navigation/native` with `useFocusEffect`, `useApp` as
 * `{ getEngine }` only) but serves rows from a call-recording fake, so each row's
 * `payloadAccess` is set directly.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer from "react-test-renderer";

let mockLocale: "en" | "es" = "en";
let mockRows: any[] = [];

const mockListRegistrationRequests = jest.fn(async (..._args: any[]) => ({ rows: mockRows, nextCursor: undefined, total: mockRows.length }));
const mockRegistrationEngine = {
	listRegistrationRequests: mockListRegistrationRequests,
	getRegistrationTransparencyStats: jest.fn(async () => undefined),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return { getRequestedSignatures: jest.fn(async () => []) };
	return null;
});
const mockNavigate = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: (_a: string) => ({ scopes: ["vrg"], loading: false }),
}));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../i18n");
			const template = (resources[mockLocale].translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: jest.fn(), setParams: jest.fn() }),
	useRoute: () => ({ params: { authorityId: "auth-1" } }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => cb(), [cb]);
	},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");
const dict = (locale: "en" | "es") => resources[locale].translation as Record<string, string>;

function row(requestId: string, payloadAccess?: string): any {
	return {
		requestId,
		authorityId: "auth-1",
		status: "p",
		issuerType: "registrant",
		submittedAt: "2026-08-01T00:00:00Z",
		receivedAt: "2026-08-01T00:00:00Z",
		hasPriorRejections: false,
		...(payloadAccess === undefined ? {} : { payloadAccess }),
	};
}

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) await Promise.resolve();
	});
}
async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Mod = require("../RegistrationInboxScreen");
	const Screen = Mod.default ?? Mod.RegistrationInboxScreen;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flushTicks(10);
	return tr;
}
function textOfNode(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOfNode(c as renderer.ReactTestInstance))).join("");
}
function exists(tr: renderer.ReactTestRenderer, testID: string): boolean {
	try {
		tr.root.findByProps({ testID });
		return true;
	} catch {
		return false;
	}
}
/** In the host tree, the testID of the sibling that directly follows the node carrying `testID`. */
function nextSiblingTestID(node: any, testID: string): string | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const c of node) {
			const r = nextSiblingTestID(c, testID);
			if (r !== undefined) return r;
		}
		return undefined;
	}
	const kids: any[] = Array.isArray(node.children) ? node.children : [];
	for (let i = 0; i < kids.length; i++) {
		if (kids[i]?.props?.testID === testID) return kids[i + 1]?.props?.testID;
	}
	for (const c of kids) {
		const r = nextSiblingTestID(c, testID);
		if (r !== undefined) return r;
	}
	return undefined;
}

const ACCESS_CODES = ["not-a-recipient", "no-opener", "unreadable", "tampered", "opened", "unsealed"];

let consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
	consoleSpies = (["log", "warn", "error", "debug", "info"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterAll(() => consoleSpies.forEach((s) => s.mockRestore()));
beforeEach(() => {
	jest.clearAllMocks();
	consoleSpies.forEach((s) => s.mockClear());
	mockLocale = "en";
	mockRows = [];
});
afterEach(() => {
	consoleSpies.forEach((s) => expect(s).not.toHaveBeenCalled());
});

describe("RegistrationInboxScreen — D-49 unreadable rows", () => {
	it("I1. a not-a-recipient row is followed directly by its reason line", async () => {
		mockRows = [row("req-a", "not-a-recipient")];
		const tr = await renderScreen();
		expect(textOfNode(tr.root.findByProps({ testID: "registration-inbox-row-content-req-a" }))).toBe(dict("en").registrationContentNotRecipient);
		expect(nextSiblingTestID(tr.toJSON(), "registration-request-row-req-a")).toBe("registration-inbox-row-content-req-a");
	});

	it("I2. each unread access shows its own copy, in EN and ES (unreadable is neither NoKey nor Tampered)", async () => {
		const CASES: Array<[string, string]> = [
			["no-opener", "registrationContentNoKey"],
			["unreadable", "registrationContentUnreadable"],
			["tampered", "registrationContentTampered"],
			["not-a-recipient", "registrationContentNotRecipient"],
		];
		for (const locale of ["en", "es"] as const) {
			for (const [access, key] of CASES) {
				jest.clearAllMocks();
				mockLocale = locale;
				mockRows = [row("req-a", access)];
				const tr = await renderScreen();
				const shown = textOfNode(tr.root.findByProps({ testID: "registration-inbox-row-content-req-a" }));
				expect(shown).toBe(dict(locale)[key]);
				if (access === "unreadable") {
					expect(shown).not.toBe(dict(locale).registrationContentNoKey);
					expect(shown).not.toBe(dict(locale).registrationContentTampered);
				}
			}
		}
	});

	it("I3. opened, unsealed and unreported rows render no content line", async () => {
		mockRows = [row("req-a", "opened"), row("req-b", "unsealed"), row("req-c")];
		const tr = await renderScreen();
		for (const id of ["req-a", "req-b", "req-c"]) {
			expect(exists(tr, "registration-request-row-" + id)).toBe(true);
			expect(exists(tr, "registration-inbox-row-content-" + id)).toBe(false);
		}
	});

	it("I4. pressing an unreadable row still navigates with exactly the identifiers", async () => {
		mockRows = [row("req-a", "tampered")];
		const tr = await renderScreen();
		const rowNode = tr.root.findByProps({ testID: "registration-request-row-req-a" });
		await renderer.act(async () => {
			rowNode.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("RegistrationRequestApproval", { requestId: "req-a", authorityId: "auth-1" });
	});

	it("I5. the line has no line limit, and no rendered text is an access code", async () => {
		mockRows = [row("req-a", "not-a-recipient"), row("req-b", "no-opener"), row("req-c", "unreadable"), row("req-d", "tampered")];
		const tr = await renderScreen();
		for (const id of ["req-a", "req-b", "req-c", "req-d"]) {
			const node = tr.root.findByProps({ testID: "registration-inbox-row-content-" + id });
			expect(node.props.numberOfLines).toBeUndefined();
			expect(node.props.ellipsizeMode).toBeUndefined();
			expect(StyleSheet.flatten(node.props.style)?.color).toBe("sentinel-textSecondary");
		}
		const rendered = tr.root
			.findAll((n) => typeof n.type === "string")
			.flatMap((n) => n.children.filter((c): c is string => typeof c === "string"));
		for (const code of ACCESS_CODES) expect(rendered).not.toContain(code);
		consoleSpies.forEach((s) => expect(s).not.toHaveBeenCalled());
	});
});
