export type RedirectPayload = {
    redirect: {
        peers: Array<{
            id: string;
            addrs: string[];
        }>;
        reason: 'not_in_cluster';
    };
};
export declare function encodePeers(peers: Array<{
    id: string;
    addrs: string[];
}>): RedirectPayload;
//# sourceMappingURL=redirect.d.ts.map