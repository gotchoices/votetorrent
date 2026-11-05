/**
 * ReassociationQueueSection.test.tsx — 62-27 (D-41/D-46): the registration inbox's entry to
 * pending device-change requests. Every engine is a jest.fn; "geometry" means flattened style
 * props (RN jest has no layout engine).
 */

import React from "react";
import fs from "fs";
import path from "path";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";

const mockNavigate = jest.fn();
let mockHasFactory = true;
let mockListResult: any[] = [];
let mockListError: unknown;

const mockListPending = jest.fn(async (..._args: any[]): Promise<any[]> => {
	if (mockListError) throw mockListError;
	return mockListResult;
});
const mockOpener = { __opener: true };
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "association") return { listPendingReassociations: mockListPending };
	if (name === "intake") return { createOpener: jest.fn(() => mockOpener) };
	return null;
});
const mockTransports = {
	strandId: "s",
	registration: { publishDecision: jest.fn(async () => "cid"), close: jest.fn(async () => undefined) },
	association: { close: jest.fn(async () => undefined) },
};
const mockCreateTransports = jest.fn((_d: any) => mockTransports);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../../i18n");
			const template = (resources.en.translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: { card: "sentinel-card", textSecondary: "sentinel-textSecondary", error: "sentinel-error", text: "sentinel-text" },
	}),
	useNavigation: () => ({ navigate: mockNavigate }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => cb(), [cb]);
	},
}));
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		createPeerStagingTransports: mockHasFactory ? mockCreateTransports : undefined,
	}),
}));
jest.mock("../../../../engines/key-vault", () => ({ resolveAuthorityKeyVault: jest.fn(() => ({ __vault: true })) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../../i18n");
const EN = resources.en.translation as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReassociationQueueSection } = require("../ReassociationQueueSection");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readOnlyReviewSign } = require("../../continuity-review");

function pendingReview(requestId: string, extra: Record<string, unknown> = {}): any {
	return { requestId, authorityId: "auth-1", status: "p", newDeviceKey: "NEWKEY-0123456789", candidates: [], existingDevices: [], evidence: { kind: "none" }, ...extra };
}

async function mount(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<ReassociationQueueSection authorityId="auth-1" />);
	});
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
	return tr;
}
function textOfNode(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOfNode(c as renderer.ReactTestInstance))).join("");
}

beforeEach(() => {
	jest.clearAllMocks();
	mockHasFactory = true;
	mockListResult = [];
	mockListError = undefined;
});

describe("ReassociationQueueSection (D-41/D-46)", () => {
	test("Q1: no transport factory renders null and never asks for an engine", async () => {
		mockHasFactory = false;
		const tr = await mount();
		expect(tr.toJSON()).toBeNull();
		expect(mockGetEngine).not.toHaveBeenCalled();
	});

	test("Q2: an empty list renders null", async () => {
		const tr = await mount();
		expect(tr.toJSON()).toBeNull();
		expect(mockListPending).toHaveBeenCalledTimes(1);
	});

	test("Q3: two reviews render a heading and two titled rows that navigate with identifiers only", async () => {
		mockListResult = [pendingReview("arq-1", { registrantName: "Ada Lovelace" }), pendingReview("arq-2")];
		const tr = await mount();
		expect(textOfNode(tr.root.findByProps({ testID: "reassociation-queue" }))).toContain(EN.registrationPolicyReassociationHeading);
		const row1 = tr.root.findByProps({ testID: "reassociation-queue-row-arq-1" });
		const row2 = tr.root.findByProps({ testID: "reassociation-queue-row-arq-2" });
		expect(textOfNode(row1)).toContain(EN.associationApprovalQueueRowTitle.replace("{{registrantName}}", "Ada Lovelace"));
		expect(textOfNode(row2)).toContain(EN.associationApprovalQueueRowTitle.replace("{{registrantName}}", "NEWKE..."));
		act(() => {
			row2.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("AssociationRequestApproval", { requestId: "arq-2", authorityId: "auth-1" });
	});

	test("Q4: a non-unavailable failure shows the load error, never the engine message", async () => {
		mockListError = new Error("ENGINE-LIST-MSG");
		const tr = await mount();
		expect(textOfNode(tr.root.findByProps({ testID: "reassociation-queue-error" }))).toBe(EN.associationApprovalLoadError);
		expect(JSON.stringify(tr.toJSON())).not.toContain("ENGINE-LIST-MSG");
	});

	test("Q5: rows are at least 44 high and stretched, and titles wrap", async () => {
		mockListResult = [pendingReview("arq-1", { registrantName: "Maximiliana Esperanza Villalobos-Etxeberria de la Cruz" })];
		const tr = await mount();
		const st = StyleSheet.flatten(tr.root.findByProps({ testID: "reassociation-queue-row-arq-1" }).props.style) as Record<string, any>;
		expect(st.minHeight).toBeGreaterThanOrEqual(44);
		expect(st.alignSelf).toBe("stretch");
		expect(tr.root.findAll((n) => n.props.numberOfLines !== undefined || n.props.ellipsizeMode !== undefined)).toHaveLength(0);
	});

	test("Q6: the session is opened read-only and closed after every load", async () => {
		mockListResult = [pendingReview("arq-1")];
		await mount();
		const deps = mockCreateTransports.mock.calls[0][0] as any;
		expect(deps.decisionSigner.sign).toBe(readOnlyReviewSign);
		expect(mockListPending.mock.calls[0][1]).toBe(mockTransports.association);
		expect(mockListPending.mock.calls[0][2]).toBe(mockOpener);
		expect(mockTransports.registration.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.association.close).toHaveBeenCalledTimes(1);

		jest.clearAllMocks();
		mockListError = new Error("x");
		await mount();
		expect(mockTransports.registration.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.association.close).toHaveBeenCalledTimes(1);
	});

	test("Q7: RegistrationInboxScreen mounts the section between the association-status chip and the filters", () => {
		const src = fs.readFileSync(path.resolve(__dirname, "../../RegistrationInboxScreen.tsx"), "utf8");
		const status = src.indexOf('testID="registration-inbox-association-request-status"');
		const section = src.indexOf("<ReassociationQueueSection");
		const filters = src.indexOf('testID="registration-inbox-filters"');
		expect(status).toBeGreaterThan(0);
		expect(section).toBeGreaterThan(status);
		expect(filters).toBeGreaterThan(section);
	});

	test("the section never signs: no createDeviceSigner, console or line limit in its source", () => {
		const src = fs
			.readFileSync(path.resolve(__dirname, "../ReassociationQueueSection.tsx"), "utf8")
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join("\n");
		expect(src).not.toMatch(/createDeviceSigner\(/);
		expect(src).not.toMatch(/console\./);
		expect(src).not.toMatch(/numberOfLines|ellipsizeMode/);
	});
});
