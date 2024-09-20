export class ElectionEngine {
    constructor(
        private readonly store: AuthorityEngineStore,
        private readonly vault: AsymmetricVault,
        private readonly trace?: TraceFunc
    ) { }

    async createElection(details: ElectionDetails, signature: string): Promise<Election> {
        this.trace?.("createElection", `details: ${JSON.stringify(details)}`);
        const key = generate
        // Election signed by authorized party biometrically?
    }
}
