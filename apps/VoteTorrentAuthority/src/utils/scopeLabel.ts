import { scopeDescriptions } from "@votetorrent/vote-core";

/** Minimal translate signature — avoids importing i18next types into screens. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The display name of an officer permission scope (`rn`, `vrg`, ...), translated through the
 * `scope_<code>` keys. vote-core's `scopeDescriptions` holds English only, and screens that
 * rendered it directly showed the permission names in English in the Spanish UI (PR-1). A missing
 * key falls back to that English description, then to the raw code.
 */
export function scopeLabel(scope: string, t: Translate): string {
	const key = `scope_${scope}`;
	const translated = t(key);
	if (translated && translated !== key) return translated;
	return scopeDescriptions[scope] ?? scope;
}

/** Every officer permission scope code, in vote-core's display order. */
export const OFFICER_SCOPE_CODES: readonly string[] = Object.keys(scopeDescriptions);
