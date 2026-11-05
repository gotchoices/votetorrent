// Host voter clock preload (phase 64 plan 21). Memory project_device_proof_clock_skew.md: the rehearsal AVDs run
// about 45 s behind the host, which expires the consensus transactions an AVD originates once a host-clock peer
// receives them. The fix aligns ONLY Date.now to the majority (AVD) clock.
//
// HV_CLOCK_OFFSET_MS = host epoch ms minus AVD epoch ms (positive when the AVD is behind), measured fresh by the rig.
// Unset or 0: no patch. An integer with abs <= 600000: Date.now = () => realNow() - offsetMs. Anything else: refused
// (the runner then writes VOID clock-offset-out-of-range).
// It patches only Date.now. It never touches the Date constructor or performance.now, so log timestamps stay true.
const raw = process.env.HV_CLOCK_OFFSET_MS
if (raw === undefined || raw === '' || raw === '0') {
  globalThis.__hvClockOffset = { offsetMs: 0, applied: false }
} else if (/^-?[0-9]{1,6}$/.test(raw) && Math.abs(Number(raw)) <= 600000) {
  const offsetMs = Number(raw)
  const realNow = Date.now.bind(Date)
  Date.now = () => realNow() - offsetMs
  globalThis.__hvClockOffset = { offsetMs, applied: true }
} else {
  globalThis.__hvClockOffset = { offsetMs: null, applied: false, refused: 'out-of-range' }
}
export {}
