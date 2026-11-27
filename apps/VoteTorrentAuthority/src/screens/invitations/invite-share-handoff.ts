/**
 * invite-share-handoff.ts - one-shot in-memory handoff of a pasted invitation share.
 *
 * The share holds the invite PRIVATE key. Route params live in navigation state for the screen's
 * whole life, so the share never travels there: AcceptInvitationScreen stashes it here and passes
 * only an opaque token; the role screen takes it once (the entry is deleted on read). Entries not
 * taken within 120 s are purged. Nothing here logs.
 */

const TTL_MS = 120_000;
const store = new Map<string, { text: string; at: number }>();

function purge(now: number): void {
	for (const [token, entry] of store) {
		if (now - entry.at > TTL_MS) store.delete(token);
	}
}

function newToken(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Fallback only for runtimes without crypto.randomUUID; the token guards nothing by itself
	// (the entry is one-shot and short-lived), it only has to be unguessable enough not to collide.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function stashInviteShare(text: string): string {
	const now = Date.now();
	purge(now);
	const token = newToken();
	store.set(token, { text, at: now });
	return token;
}

export function takeInviteShare(token: string | undefined): string | undefined {
	const now = Date.now();
	purge(now);
	if (!token) return undefined;
	const entry = store.get(token);
	if (!entry) return undefined;
	store.delete(token);
	return entry.text;
}
