/**
 * Jest manual mock for react-native-share (Phase 64 plan 64-01, D-04).
 *
 * The real module is a native TurboModule (share sheet, FileProvider) that cannot load under
 * jest, and `transformIgnorePatterns` does not transform it. Mapped by jest.config.js; production
 * uses the real module. Never calls console.*.
 */
const Social = {};

const Share = {
  open: jest.fn(() => Promise.resolve({success: true, message: ''})),
  shareSingle: jest.fn(() => Promise.resolve({success: true, message: ''})),
  isPackageInstalled: jest.fn(() => Promise.resolve({isInstalled: false, message: ''})),
  Social,
};

module.exports = {
  __esModule: true,
  default: Share,
  Social,
};
