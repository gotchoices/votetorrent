/**
 * bootstrap-config.ts — binding over the D-14 bootstrap-config validator, which moved to
 * `packages/workflows/src/common/bootstrap-config.ts` (phase 67 plan 08) as its ONE copy. This path
 * stays so CadreNodeProvider, the fault-notice surfaces and the suites import it unchanged. The file
 * is byte-identical in both RN apps and the Authority suite's D-14 anti-drift gate pins that, and
 * pins that both stay pure re-exports with no validator logic of their own.
 */
export { BOOTSTRAP_ADDR_MAX_LENGTH, BOOTSTRAP_CONFIG_MAX_ADDRS, isBootstrapAddr, readBootstrapConfig } from '@votetorrent/workflows';
export type { BootstrapConfigFault, BootstrapConfigFaultReason, BootstrapConfigResult } from '@votetorrent/workflows';
