import { connectToStrandBrowser } from "./connect-browser.js";
import { parseConfig } from "./parse-config.js";
async function register(db, config = {}) {
  const options = parseConfig(config);
  return connectToStrandBrowser(db, options);
}
export {
  register as default,
  parseConfig
};
