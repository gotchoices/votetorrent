/** Categories of peer misbehavior with associated severity */
export var PenaltyReason;
(function (PenaltyReason) {
    /** Peer sent a signature that failed cryptographic verification */
    PenaltyReason["InvalidSignature"] = "invalid-signature";
    /** Peer promised conflicting transactions (equivocation) */
    PenaltyReason["Equivocation"] = "equivocation";
    /** Peer's validation logic rejected a valid transaction (repeated false rejections) */
    PenaltyReason["FalseRejection"] = "false-rejection";
    /** Peer failed to respond within timeout during consensus */
    PenaltyReason["ConsensusTimeout"] = "consensus-timeout";
    /** Peer sent a message with mismatched hash */
    PenaltyReason["InvalidMessageHash"] = "invalid-message-hash";
    /** Peer sent an expired transaction */
    PenaltyReason["ExpiredTransaction"] = "expired-transaction";
    /** Generic protocol violation */
    PenaltyReason["ProtocolViolation"] = "protocol-violation";
    /** Connection-level failures (lighter weight) */
    PenaltyReason["ConnectionFailure"] = "connection-failure";
    /** Majority peer approved a transaction that was later found invalid via dispute */
    PenaltyReason["FalseApproval"] = "false-approval";
    /** Challenger lost a dispute (their rejection was wrong) */
    PenaltyReason["DisputeLost"] = "dispute-lost";
})(PenaltyReason || (PenaltyReason = {}));
/** Default penalty weights by reason */
export const DEFAULT_PENALTY_WEIGHTS = {
    [PenaltyReason.InvalidSignature]: 50,
    [PenaltyReason.Equivocation]: 100,
    [PenaltyReason.FalseRejection]: 10,
    [PenaltyReason.ConsensusTimeout]: 5,
    [PenaltyReason.InvalidMessageHash]: 50,
    [PenaltyReason.ExpiredTransaction]: 3,
    [PenaltyReason.ProtocolViolation]: 30,
    [PenaltyReason.ConnectionFailure]: 2,
    [PenaltyReason.FalseApproval]: 40,
    [PenaltyReason.DisputeLost]: 30,
};
export const DEFAULT_THRESHOLDS = {
    deprioritize: 20,
    ban: 80,
};
//# sourceMappingURL=types.js.map