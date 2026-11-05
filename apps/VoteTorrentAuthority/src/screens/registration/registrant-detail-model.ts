import type {
	PrivateDetail,
	RegistrantPublic,
	RegistrantStatus,
	RegistrationContentAccess,
} from "@votetorrent/vote-core";

/**
 * registrant-detail-model.ts — the pure, renderer-free derivation module
 * behind `RegistrantDetailScreen` (D-10/D-12/D-13). Every decision that does
 * NOT require a render, an engine, a theme, or i18n resolution lives here:
 * the D-10 lifecycle action table and its no-op suppression, and the flat
 * display-row projections for the private and public tiers.
 *
 * This module is deliberately React-free, theme-free, engine-free and
 * i18n-free. Its only import is `import type` — no runtime value ever
 * crosses in from `@votetorrent/vote-core`, and nothing here resolves a
 * translation key; every `*Key` field below is an i18n key NAME the owning
 * screen resolves with `t()`.
 */

/** The four D-10 lifecycle actions, in a fixed display order. */
export type LifecycleActionId = "renew" | "reinstate" | "suspend" | "revoke";

export interface LifecycleActionMeta {
	id: LifecycleActionId;
	variant: "ordinary" | "typed";
	tone: "neutral" | "destructive";
	/** `undefined` for `renew` — see the LIFECYCLE_ACTIONS doc comment below. */
	targetStatus: RegistrantStatus | undefined;
	buttonLabelKey: string;
	titleKey: string;
	bodyKey: string;
	confirmLabelKey: string;
	dismissLabelKey: string;
}

/**
 * The exhaustive D-10 lifecycle action table, one entry per `LifecycleActionId`.
 *
 * `renew.targetStatus` is `undefined` — deliberately, not an oversight.
 * Renewal calls `changeExpiration`, never `changeStatus`; a reader who "fixes"
 * this to `'a'` would silently convert a renewal into a reinstatement, which
 * both records the wrong write and skips the expiration prompt entirely.
 *
 * `suspend` and `revoke` share `variant: "typed"` on purpose: D-10 groups
 * suspend AND revoke together behind the typed confirmation. Narrowing this
 * to "revoke alone" is the wrong reading of D-10 — it would leave the more
 * common destructive action (suspending a registrant) one accidental tap
 * away with no typed safeguard.
 */
export const LIFECYCLE_ACTIONS: Record<LifecycleActionId, LifecycleActionMeta> = {
	renew: {
		id: "renew",
		variant: "ordinary",
		tone: "neutral",
		targetStatus: undefined,
		buttonLabelKey: "registrantLifecycleRenewButton",
		titleKey: "registrantLifecycleRenewTitle",
		bodyKey: "registrantLifecycleRenewBody",
		confirmLabelKey: "registrantLifecycleConfirmRenewal",
		dismissLabelKey: "registrantLifecycleKeepCurrentExpiration",
	},
	reinstate: {
		id: "reinstate",
		variant: "ordinary",
		tone: "neutral",
		targetStatus: "a",
		buttonLabelKey: "registrantLifecycleReinstateButton",
		titleKey: "registrantLifecycleReinstateTitle",
		bodyKey: "registrantLifecycleReinstateBody",
		confirmLabelKey: "registrantLifecycleConfirmReinstatement",
		dismissLabelKey: "registrantLifecycleKeepCurrentStatus",
	},
	suspend: {
		id: "suspend",
		variant: "typed",
		tone: "destructive",
		targetStatus: "s",
		buttonLabelKey: "registrantLifecycleSuspendButton",
		titleKey: "registrantLifecycleSuspendTitle",
		bodyKey: "registrantLifecycleSuspendBody",
		confirmLabelKey: "registrantLifecycleSuspendButton",
		dismissLabelKey: "registrantLifecycleKeepCurrentStatus",
	},
	revoke: {
		id: "revoke",
		variant: "typed",
		tone: "destructive",
		targetStatus: "r",
		buttonLabelKey: "registrantLifecycleRevokeButton",
		titleKey: "registrantLifecycleRevokeTitle",
		bodyKey: "registrantLifecycleRevokeBody",
		confirmLabelKey: "registrantLifecycleRevokeButton",
		dismissLabelKey: "registrantLifecycleKeepCurrentStatus",
	},
};

/** Fixed display order for the lifecycle button row — never derived from `Object.keys`. */
const LIFECYCLE_ACTION_ORDER: readonly LifecycleActionId[] = ["renew", "reinstate", "suspend", "revoke"];

/**
 * `target !== undefined && target === current`. An `undefined` target
 * (renew) is never a no-op: it carries a new expiration date, not a status,
 * so there is no "current status" for it to collide with.
 */
export function isNoOpTransition(current: RegistrantStatus, target: RegistrantStatus | undefined): boolean {
	return target !== undefined && target === current;
}

/**
 * Every lifecycle action whose transition would NOT be a no-op against
 * `current`, in the fixed `LIFECYCLE_ACTION_ORDER` display order.
 *
 * The one reconciliation this table makes against `47-UI-SPEC.md:650`'s
 * summary ("Renew/Reinstate visible when Suspended/Revoked; Suspend/Revoke
 * visible when Active") is the `r` -> `s` case that summary does not cover.
 * The BINDING rule is the sentence that follows it in the spec: never render
 * a status-change button that would be a no-op transition to the CURRENT
 * status. Under that rule, Suspend IS offered on a Revoked registrant — it
 * is a real transition the deliberately-permissive engine accepts (Phase 42
 * D-16 removed the transition guard), and suppressing it would be this
 * screen inventing a policy the engine does not hold. Stated here plainly
 * rather than chosen silently.
 */
export function availableLifecycleActions(current: RegistrantStatus): LifecycleActionId[] {
	return LIFECYCLE_ACTION_ORDER.filter(
		(id) => !isNoOpTransition(current, LIFECYCLE_ACTIONS[id].targetStatus),
	);
}

/** The shared label:value row shape both tier projections below return. */
export interface DetailFieldRow {
	name: string;
	value: string;
}

/** Recursion guard for `flattenPrivateDetails` — malformed stored JSON must not hang a render. */
const MAX_PRIVATE_DETAIL_DEPTH = 8;

function flattenPrivateDetailsAt(
	details: readonly PrivateDetail[],
	depth: number,
	namePrefix: string,
): DetailFieldRow[] {
	if (depth >= MAX_PRIVATE_DETAIL_DEPTH) return [];
	const rows: DetailFieldRow[] = [];
	for (const detail of details) {
		if (typeof detail?.name !== "string" || detail.name.trim().length === 0) continue;
		const qualifiedName = namePrefix.length > 0 ? namePrefix + "." + detail.name : detail.name;
		if (Array.isArray(detail.value)) {
			rows.push(...flattenPrivateDetailsAt(detail.value, depth + 1, qualifiedName));
		} else {
			// `String(...)` only — never a template literal that could be spliced
			// into a diagnostic message. This branch produces display strings and
			// nothing else; it builds no other string, throws nothing, and writes
			// nothing to the debug console.
			rows.push({ name: qualifiedName, value: String(detail.value) });
		}
		// `detail.hint` is deliberately NOT projected here. It is authored
		// per-registrant and could paraphrase the value; the tier renders
		// name + masked value only.
	}
	return rows;
}

/**
 * Depth-first flatten of the recursive `PrivateDetail` tree into display
 * rows. A scalar `value` emits one row (`String(value)`); an array `value`
 * recurses, prefixing each child's `name` with the parent's name and a `.`
 * separator (`"Address" + "." + "Street"`) — the parent itself emits no row
 * of its own. Never `JSON.stringify`s: recursion is what makes a nested
 * detail render as separate labelled rows, and serialising a subtree would
 * dump a whole private object into one masked field instead of one per leaf.
 *
 * Returns `[]` for `undefined`, a non-array input, or an empty list. Skips
 * any entry whose `name` is not a non-empty trimmed string, without
 * throwing.
 */
export function flattenPrivateDetails(details: readonly PrivateDetail[] | undefined): DetailFieldRow[] {
	if (!Array.isArray(details) || details.length === 0) return [];
	return flattenPrivateDetailsAt(details, 0, "");
}

function isRenderablePublicValue(value: unknown): value is string | number | boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string" && value.trim().length === 0) return false;
	return true;
}

/**
 * Projects the public tier to rows in the fixed order `lastName`,
 * `firstName`, `district`, then each `extraFields` key in `Object.keys`
 * order. Omits any field whose value is `undefined`, `null`, or an empty
 * trim. Coerces with `String(...)`; an object-valued extra field is coerced
 * as-is rather than serialised — the public tier is flat by schema (Phase 42
 * D-18), so an object here is malformed data, not a case to support.
 *
 * Row labels are the RAW stored field names, deliberately: the i18n map has
 * no `lastName`/`firstName` key and Phase 47's `registrant-keys.test.ts`
 * pins the phase total, so no label key may be added here. All three tiers
 * on the detail screen therefore label with the raw stored name —
 * `PrivateFieldRow` renders `PrivateDetail.name`, `SelectiveAudiencePreview`
 * renders the raw leaf name, and this does the same for the public tier.
 * That uniformity is the point, not a gap — the same reasoning 47-11
 * recorded for rendering raw district strings as chip labels.
 */
export function toPublicTierRows(publicTier: RegistrantPublic | undefined): DetailFieldRow[] {
	if (!publicTier) return [];
	const rows: DetailFieldRow[] = [];
	const fixedFields: ReadonlyArray<readonly [string, unknown]> = [
		["lastName", publicTier.lastName],
		["firstName", publicTier.firstName],
		["district", publicTier.district],
	];
	for (const [name, value] of fixedFields) {
		if (isRenderablePublicValue(value)) rows.push({ name, value: String(value) });
	}
	if (publicTier.extraFields) {
		for (const name of Object.keys(publicTier.extraFields)) {
			const value = publicTier.extraFields[name];
			if (isRenderablePublicValue(value)) rows.push({ name, value: String(value) });
		}
	}
	return rows;
}

/** How the Private tier's sealed details read on THIS device (D-49, D-51). */
export type PrivateTierReadState = "readable" | "not-a-recipient" | "no-key" | "unreadable";

/**
 * Maps the engine's `RegistrationContentAccess` for a registrant's private details onto the
 * Private tier's render state. undefined means "not reported" (a mock engine) and reads as
 * 'readable'. 'tampered' cannot come from the private-tier reader (that table has no PayloadCid),
 * but the field's type allows it, so it fails closed to 'unreadable'.
 *
 * The request-level keys `registrationContentNotRecipient` and `registrationContentTampered`
 * deliberately do not apply here: their copy speaks of a request and an applicant's signature, and
 * this screen shows a registrant record sealed by officers (the request screens render them).
 */
export function privateTierReadState(access: RegistrationContentAccess | undefined): PrivateTierReadState {
	switch (access) {
		case undefined:
		case "opened":
		case "unsealed":
			return "readable";
		case "not-a-recipient":
			return "not-a-recipient";
		case "no-opener":
			return "no-key";
		case "unreadable":
		case "tampered":
			return "unreadable";
		default: {
			const unreachable: never = access;
			return unreachable;
		}
	}
}

/** i18n key per unread state. Fixed keys only: no value, ciphertext or failure detail is ever copy. */
export const PRIVATE_TIER_READ_STATE_COPY = {
	"not-a-recipient": "registrantPrivateNotRecipient",
	"no-key": "registrationContentNoKey",
	unreadable: "registrantPrivateUnreadable",
} as const;

/** How the Selective tier's sealed details read on THIS device (D-52, D-51). */
export type SelectiveTierReadState = "readable" | "not-a-recipient" | "no-key" | "unreadable" | "tampered";

/**
 * Maps `RegistrantSelective.detailsAccess` onto the Selective tier's render state. undefined means
 * "not reported" (a mock engine) and reads as 'readable'. 'tampered' means the details do not match
 * the registrant's signed commitment: an integrity failure, shown distinctly so it is never mistaken
 * for a device or key problem. 'unreadable' stays its own device-side state.
 */
export function selectiveTierReadState(access: RegistrationContentAccess | undefined): SelectiveTierReadState {
	switch (access) {
		case undefined:
		case "opened":
		case "unsealed":
			return "readable";
		case "not-a-recipient":
			return "not-a-recipient";
		case "no-opener":
			return "no-key";
		case "unreadable":
			return "unreadable";
		case "tampered":
			return "tampered";
		default: {
			const unreachable: never = access;
			return unreachable;
		}
	}
}

/**
 * i18n key per unread selective state (D-52). Fixed keys only: no value, salt or failure detail is
 * ever copy. The no-key state reuses `registrationContentNoKey`, whose wording (this device has no
 * encrypted intake key) applies equally to the selective tier.
 */
export const SELECTIVE_TIER_READ_STATE_COPY = {
	"not-a-recipient": "registrantSelectiveNotRecipient",
	"no-key": "registrationContentNoKey",
	unreadable: "registrantSelectiveUnreadable",
	tampered: "registrantSelectiveTampered",
} as const;
