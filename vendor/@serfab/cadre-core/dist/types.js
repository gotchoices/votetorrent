const HIBERNATION_TIMEOUTS = {
  realtime: {
    idleTimeout: Infinity,
    // Never idle
    hibernateTimeout: Infinity,
    // Never hibernate
    checkInInterval: Infinity
    // N/A
  },
  interactive: {
    idleTimeout: 5 * 60 * 1e3,
    // 5 minutes
    hibernateTimeout: 15 * 60 * 1e3,
    // 15 minutes after idle
    checkInInterval: 30 * 1e3
    // 30 seconds
  },
  background: {
    idleTimeout: 1 * 60 * 1e3,
    // 1 minute
    hibernateTimeout: 5 * 60 * 1e3,
    // 5 minutes after idle
    checkInInterval: 5 * 60 * 1e3
    // 5 minutes
  },
  archive: {
    idleTimeout: 10 * 1e3,
    // 10 seconds
    hibernateTimeout: 30 * 1e3,
    // 30 seconds after idle
    checkInInterval: 60 * 60 * 1e3
    // 1 hour
  }
};
export {
  HIBERNATION_TIMEOUTS
};
