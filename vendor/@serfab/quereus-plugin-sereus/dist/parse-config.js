function parseConfig(config) {
  const strandId = config.strand_id;
  if (typeof strandId !== "string" || !strandId) {
    throw new Error("quereus-plugin-sereus: strand_id is required");
  }
  const bootstrapNodesRaw = config.bootstrap_nodes;
  const bootstrapNodes = typeof bootstrapNodesRaw === "string" && bootstrapNodesRaw ? bootstrapNodesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const schema = typeof config.schema === "string" ? config.schema : void 0;
  const sAppId = typeof config.sapp_id === "string" ? config.sapp_id : "unknown";
  const sAppVersion = typeof config.sapp_version === "string" ? config.sapp_version : "1.0.0";
  const port = typeof config.port === "number" ? config.port : 0;
  const enableCache = config.enable_cache !== false && config.enable_cache !== 0;
  const fretProfile = config.fret_profile === "core" ? "core" : "edge";
  const mode = config.mode === "bootstrap" || config.mode === "networked" ? config.mode : void 0;
  const transactor = typeof config.transactor === "string" && config.transactor ? config.transactor : void 0;
  return {
    strandId,
    bootstrapNodes,
    schema,
    sAppId,
    sAppVersion,
    port,
    enableCache,
    fretProfile,
    ...mode && { mode },
    ...transactor && { transactor }
  };
}
export {
  parseConfig
};
