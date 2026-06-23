import debug from "debug";
import { HIBERNATION_TIMEOUTS } from "./types.js";
const log = debug("sereus:cadre:hibernation");
class HibernationManager {
  constructor(config, callbacks) {
    this.timers = /* @__PURE__ */ new Map();
    this.checkInTimers = /* @__PURE__ */ new Map();
    this.running = false;
    this.config = config;
    this.callbacks = callbacks;
    log("HibernationManager created, enabled=%s", config.enabled);
  }
  /**
   * Get effective timeouts for a latency hint
   */
  getTimeouts(hint) {
    const defaults = HIBERNATION_TIMEOUTS[hint];
    const custom = this.config.customTimeouts?.[hint];
    if (!custom) return defaults;
    return {
      idleTimeout: custom.idleTimeout ?? defaults.idleTimeout,
      hibernateTimeout: custom.hibernateTimeout ?? defaults.hibernateTimeout,
      checkInInterval: custom.checkInInterval ?? defaults.checkInInterval
    };
  }
  /**
   * Start managing hibernation for all strands
   */
  start() {
    if (this.running) return;
    this.running = true;
    log("HibernationManager started");
  }
  /**
   * Stop managing hibernation
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.checkInTimers.values()) {
      clearInterval(timer);
    }
    this.checkInTimers.clear();
    log("HibernationManager stopped");
  }
  /**
   * Register a strand for hibernation management
   */
  trackStrand(instance) {
    if (!this.config.enabled || !this.running) return;
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    if (timeouts.idleTimeout === Infinity) {
      log("Strand %s has realtime latency hint - no hibernation", strandId);
      return;
    }
    log("Tracking strand %s for hibernation (hint=%s)", strandId, latencyHint);
    this.scheduleIdleTransition(instance);
  }
  /**
   * Untrack a strand from hibernation management
   */
  untrackStrand(strandId) {
    this.clearTimers(strandId);
    log("Untracked strand %s from hibernation", strandId);
  }
  /**
   * Record activity on a strand - resets idle timer
   */
  recordActivity(instance) {
    if (!this.config.enabled || !this.running) return;
    const { strandId, status, latencyHint } = instance;
    instance.lastActivity = /* @__PURE__ */ new Date();
    if (status === "idle" || status === "hibernating") {
      log("Activity on %s strand %s - waking", status, strandId);
      this.clearTimers(strandId);
      void this.callbacks.onWake(strandId);
    }
    if (status === "active") {
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.idleTimeout !== Infinity) {
        this.scheduleIdleTransition(instance);
      }
    }
  }
  /**
   * Force wake a hibernating strand
   */
  async wakeStrand(strandId) {
    this.clearTimers(strandId);
    await this.callbacks.onWake(strandId);
  }
  scheduleIdleTransition(instance) {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    this.clearTimer(strandId);
    const timer = setTimeout(() => {
      this.handleIdleTimeout(instance);
    }, timeouts.idleTimeout);
    this.timers.set(strandId, timer);
  }
  handleIdleTimeout(instance) {
    const { strandId, latencyHint } = instance;
    if (!this.running) return;
    log("Idle timeout for strand %s", strandId);
    void this.callbacks.onIdle(strandId).then(() => {
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.hibernateTimeout !== Infinity) {
        this.scheduleHibernateTransition(instance);
      }
    });
  }
  scheduleHibernateTransition(instance) {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    this.clearTimer(strandId);
    const timer = setTimeout(() => {
      this.handleHibernateTimeout(instance);
    }, timeouts.hibernateTimeout);
    this.timers.set(strandId, timer);
  }
  handleHibernateTimeout(instance) {
    const { strandId, latencyHint } = instance;
    if (!this.running) return;
    log("Hibernate timeout for strand %s", strandId);
    void this.callbacks.onHibernate(strandId).then(() => {
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.checkInInterval !== Infinity) {
        this.scheduleCheckIn(instance);
      }
    });
  }
  scheduleCheckIn(instance) {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    const existing = this.checkInTimers.get(strandId);
    if (existing) {
      clearInterval(existing);
    }
    const timer = setInterval(() => {
      if (!this.running) {
        clearInterval(timer);
        return;
      }
      log("Check-in for hibernating strand %s", strandId);
      instance.nextCheckIn = new Date(Date.now() + timeouts.checkInInterval);
    }, timeouts.checkInInterval);
    this.checkInTimers.set(strandId, timer);
    instance.nextCheckIn = new Date(Date.now() + timeouts.checkInInterval);
  }
  clearTimer(strandId) {
    const timer = this.timers.get(strandId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(strandId);
    }
  }
  clearTimers(strandId) {
    this.clearTimer(strandId);
    const checkInTimer = this.checkInTimers.get(strandId);
    if (checkInTimer) {
      clearInterval(checkInTimer);
      this.checkInTimers.delete(strandId);
    }
  }
  /**
   * Get the current status of hibernation tracking
   */
  getStatus() {
    return {
      enabled: this.config.enabled && this.running,
      trackedStrands: this.timers.size + this.checkInTimers.size
    };
  }
}
export {
  HibernationManager
};
