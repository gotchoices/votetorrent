/**
 * Jest manual mock for react-native-vision-camera (Phase 64 plan 64-01, D-05).
 *
 * VisionCamera 5 is a Nitro HybridObject binding: its real entry point reaches the native module
 * through react-native-nitro-modules, which cannot load under jest, and `transformIgnorePatterns`
 * does not transform the package. Mapped by jest.config.js. Production uses the real module.
 *
 * Seams (the scanner plans build on these; reach the `__` controls through require() of this FILE):
 *  - Camera renders a 'VisionCameraMock' host element carrying every prop; no native call.
 *  - useCameraDevice / useCameraDevices read a configurable device.
 *  - useCameraPermission keeps the status as React state; requestPermission applies the configured
 *    result. useMicrophonePermission().requestPermission always rejects (no microphone, ever).
 * Never calls console.*.
 */
const React = require('react');

const DEFAULT_DEVICE = {id: 'mock-back-camera', position: 'back'};
let device = DEFAULT_DEVICE;
let permissionStatus = 'authorized';
let requestResult = 'authorized';
let requestCount = 0;

function Camera(props) {
  return React.createElement('VisionCameraMock', props);
}

function useCameraDevice() {
  return device;
}

function useCameraDevices() {
  return device ? [device] : [];
}

function useCameraPermission() {
  const [status, setStatus] = React.useState(permissionStatus);
  const requestPermission = React.useCallback(() => {
    requestCount += 1;
    if (requestResult instanceof Error) {
      return Promise.reject(requestResult);
    }
    setStatus(requestResult);
    return Promise.resolve(requestResult === 'authorized');
  }, []);
  return {
    status,
    hasPermission: status === 'authorized',
    canRequestPermission: status === 'not-determined',
    requestPermission,
  };
}

function useMicrophonePermission() {
  return {
    status: 'denied',
    hasPermission: false,
    canRequestPermission: false,
    requestPermission: () =>
      Promise.reject(new Error('microphone permission must never be requested')),
  };
}

module.exports = {
  __esModule: true,
  Camera,
  useCameraDevice,
  useCameraDevices,
  useCameraPermission,
  useMicrophonePermission,
  __setCameraDevice(d) {
    device = d;
  },
  __setCameraPermissionStatus(s) {
    permissionStatus = s;
  },
  __setCameraPermissionRequestResult(r) {
    requestResult = r;
  },
  __cameraPermissionRequestCount() {
    return requestCount;
  },
  __resetVisionCameraMock() {
    device = DEFAULT_DEVICE;
    permissionStatus = 'authorized';
    requestResult = 'authorized';
    requestCount = 0;
  },
};
