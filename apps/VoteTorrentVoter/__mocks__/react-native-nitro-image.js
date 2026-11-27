/**
 * Jest manual mock for react-native-nitro-image (Phase 64 plan 64-01, D-05).
 *
 * VisionCamera 5 declares it as a peer. It is a Nitro HybridObject binding that cannot load under
 * jest and is not transformed by `transformIgnorePatterns`. Production uses the real module.
 * Never calls console.*.
 */
const React = require('react');

function NitroImage(props) {
  return React.createElement('NitroImageMock', props);
}

module.exports = {
  __esModule: true,
  NitroImage,
  useImage() {
    return {image: undefined, error: undefined};
  },
  loadImage() {
    return Promise.reject(new Error('react-native-nitro-image is native-only and unavailable under jest'));
  },
};
