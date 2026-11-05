/**
 * Jest manual mock for react-native-vision-camera-barcode-scanner (Phase 64 plan 64-01, D-05).
 *
 * The real package is a Nitro HybridObject binding that cannot load under jest, and
 * `transformIgnorePatterns` does not transform it. Mapped by jest.config.js; production uses the
 * real module.
 *
 * The app composes <Camera outputs={[useBarcodeScannerOutput(...)]} /> (planning notes 4.9), so
 * CodeScanner and useBarcodeScanner throw here: a screen that reaches for them fails under jest.
 * `__emitBarcodes` calls the latest onBarcodeScanned; the mock keeps handlers only, never a
 * payload. Never calls console.*.
 */
const NOT_USED =
  'CodeScanner is not used by VoteTorrent: compose Camera with useBarcodeScannerOutput';

let recorded = [];
let latest = {onBarcodeScanned: undefined, onError: undefined};

function useBarcodeScannerOutput(options) {
  const {barcodeFormats, outputResolution = 'preview', onBarcodeScanned, onError} = options;
  const entry = {barcodeFormats, outputResolution, onBarcodeScanned, onError};
  recorded.push(entry);
  latest = {onBarcodeScanned, onError};
  return {kind: 'barcode-scanner-output', barcodeFormats, outputResolution};
}

function CodeScanner() {
  throw new Error(NOT_USED);
}

function useBarcodeScanner() {
  throw new Error(NOT_USED);
}

module.exports = {
  __esModule: true,
  useBarcodeScannerOutput,
  CodeScanner,
  useBarcodeScanner,
  __emitBarcodes(barcodes) {
    if (latest.onBarcodeScanned) {
      latest.onBarcodeScanned(barcodes);
    }
  },
  __emitBarcodeScannerError(error) {
    if (latest.onError) {
      latest.onError(error);
    }
  },
  __barcodeScannerOutputs() {
    return recorded.slice();
  },
  __resetBarcodeScannerMock() {
    recorded = [];
    latest = {onBarcodeScanned: undefined, onError: undefined};
  },
};
