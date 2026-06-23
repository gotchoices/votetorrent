export function encodePeers(peers) {
    return {
        redirect: {
            peers,
            reason: 'not_in_cluster'
        }
    };
}
//# sourceMappingURL=redirect.js.map