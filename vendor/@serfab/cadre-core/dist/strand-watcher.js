import debug from "debug";
const log = debug("sereus:cadre:strand-watcher");
class StrandWatcher {
  constructor(queryable, callbacks, filter = { mode: "all" }, pollInterval = 5e3, sAppIdLookup) {
    this.knownStrands = /* @__PURE__ */ new Map();
    this.pollTimer = null;
    this.initialPollTimer = null;
    this.running = false;
    this.queryable = queryable;
    this.callbacks = callbacks;
    this.filter = filter;
    this.pollInterval = pollInterval;
    this.sAppIdLookup = sAppIdLookup;
    log("StrandWatcher created with filter: %o, interval: %dms", filter, pollInterval);
  }
  /**
   * Check if a strand passes the current filter
   */
  passesFilter(strand) {
    switch (this.filter.mode) {
      case "all":
        return true;
      case "none":
        return false;
      case "strandId":
        return strand.Id === this.filter.strandId;
      case "sAppId": {
        const sAppId = this.sAppIdLookup?.getSAppId(strand.Id);
        if (sAppId === void 0) {
          log("sAppId unknown for strand %s - deferring filter decision", strand.Id);
          return true;
        }
        const matches = sAppId === this.filter.sAppId;
        log(
          "sAppId filter: strand %s has sAppId %s, filter wants %s, match=%s",
          strand.Id,
          sAppId,
          this.filter.sAppId,
          matches
        );
        return matches;
      }
      default:
        return true;
    }
  }
  /**
   * Poll for strand changes
   */
  async poll() {
    if (!this.running) return;
    try {
      const currentStrands = await this.queryable.queryStrands();
      const currentMap = new Map(currentStrands.map((s) => [s.Id, s]));
      for (const strand of currentStrands) {
        if (!this.knownStrands.has(strand.Id) && this.passesFilter(strand)) {
          log("Strand added: %s", strand.Id);
          this.knownStrands.set(strand.Id, strand);
          try {
            await this.callbacks.onStrandAdded(strand);
          } catch (error) {
            log("Error handling strand add for %s: %o", strand.Id, error);
          }
        }
      }
      for (const [strandId] of this.knownStrands) {
        if (!currentMap.has(strandId)) {
          log("Strand removed: %s", strandId);
          this.knownStrands.delete(strandId);
          try {
            await this.callbacks.onStrandRemoved(strandId);
          } catch (error) {
            log("Error handling strand remove for %s: %o", strandId, error);
          }
        }
      }
    } catch (error) {
      log("Error polling strands: %o", error);
    }
  }
  /**
   * Start watching for strand changes
   */
  async start() {
    if (this.running) {
      log("StrandWatcher already running");
      return;
    }
    log("Starting StrandWatcher");
    this.running = true;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollInterval);
    this.initialPollTimer = setTimeout(() => {
      this.initialPollTimer = null;
      void this.poll();
    }, 100);
    log("StrandWatcher started");
  }
  /**
   * Stop watching for strand changes
   */
  async stop() {
    if (!this.running) {
      return;
    }
    log("Stopping StrandWatcher");
    this.running = false;
    if (this.initialPollTimer) {
      clearTimeout(this.initialPollTimer);
      this.initialPollTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.knownStrands.clear();
    log("StrandWatcher stopped");
  }
  /**
   * Get currently known strands
   */
  getKnownStrands() {
    return new Map(this.knownStrands);
  }
  /**
   * Force an immediate poll (useful for testing)
   */
  async forcePoll() {
    await this.poll();
  }
}
export {
  StrandWatcher
};
