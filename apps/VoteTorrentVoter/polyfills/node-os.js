/**
 * Minimal polyfill for node:os module in React Native.
 * Only implements the methods that libp2p actually uses.
 */

import { Platform } from 'react-native';

export function networkInterfaces() {
  // Return empty object - libp2p will fall back to other discovery methods
  return {};
}

export function platform() {
  return Platform.OS;
}

export function type() {
  return Platform.OS === 'ios' ? 'Darwin' : 'Linux';
}

export function hostname() {
  return 'localhost';
}

// Default export for compatibility
export default {
  networkInterfaces,
  platform,
  type,
  hostname,
};
