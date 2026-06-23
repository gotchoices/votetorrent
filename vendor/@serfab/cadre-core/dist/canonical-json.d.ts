/**
 * Canonical JSON serialization for signed payloads.
 *
 * Recursively sorts object keys, drops `undefined` values, emits no whitespace
 * and no trailing newline. Arrays preserve their order. This is a tiny RFC 8785
 * subset, sufficient for the fixed-shape payloads we sign (update manifests in
 * cadre-host, control-network seeds here).
 *
 * Lives in cadre-core because cadre-host depends on cadre-core (not the
 * reverse); cadre-host re-imports this rather than keeping its own copy.
 */
export declare function canonicalJson(value: unknown): string;
