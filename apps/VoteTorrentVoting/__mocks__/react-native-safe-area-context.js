// Jest mock for react-native-safe-area-context — the real hooks require a SafeAreaProvider host
// that react-test-renderer doesn't set up. Zero insets keep layout math deterministic in tests.
const React = require('react');

const insets = {top: 0, right: 0, bottom: 0, left: 0};
const frame = {x: 0, y: 0, width: 390, height: 844};

module.exports = {
	SafeAreaProvider: ({children}) => children,
	SafeAreaView: ({children}) => children,
	SafeAreaInsetsContext: React.createContext(insets),
	useSafeAreaInsets: () => insets,
	useSafeAreaFrame: () => frame,
	initialWindowMetrics: {insets, frame},
};
