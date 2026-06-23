import type { ITransactor, CollectionId } from "../../index.js";
export declare class Diary<TEntry> {
    private readonly collection;
    private constructor();
    static create<TEntry>(network: ITransactor, id: CollectionId): Promise<Diary<TEntry>>;
    append(data: TEntry): Promise<void>;
    /** Fetch the latest state from the network */
    update(): Promise<void>;
    select(forward?: boolean): AsyncIterableIterator<TEntry>;
}
//# sourceMappingURL=diary.d.ts.map