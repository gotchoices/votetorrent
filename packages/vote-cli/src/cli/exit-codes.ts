// The exit code table every vt command and daemon shares.
//
// 0 PASS, 1 FAIL, 2 usage (bad or missing arguments), 3 the daemon a command was sent to is
// unreachable (the rig's hr5-ctl code, kept so existing wrappers can tell "it failed" from
// "nobody answered").

export const EXIT = Object.freeze({
  PASS: 0,
  FAIL: 1,
  USAGE: 2,
  UNREACHABLE: 3
} as const)

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
