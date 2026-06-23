/**
 * Portable type aliases for peer networking.
 *
 * These minimal structural types decouple db-core from any concrete
 * networking library (e.g. libp2p).  Concrete implementations in
 * transport packages (db-p2p) satisfy these structurally.
 */
/** Minimal peer identifier — structurally compatible with libp2p's PeerId. */
export type PeerId = {
    toString(): string;
    equals(other: unknown): boolean;
};
/** Opaque network stream — db-core never accesses stream internals. */
export type Stream = {
    close(): Promise<void>;
};
/** Options for abortable operations. */
export type AbortOptions = {
    signal?: AbortSignal;
};
/** Create a lightweight PeerId from its string representation. */
export declare function peerIdFromString(id: string): PeerId;
//# sourceMappingURL=types.d.ts.map