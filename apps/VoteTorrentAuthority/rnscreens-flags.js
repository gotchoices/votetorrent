/**
 * react-native-screens feature flags. Imported by index.js BEFORE the App module, so it runs
 * before any Screen renders.
 *
 * androidResetScreenShadowStateOnOrientationChangeEnabled (default true) registers an Android
 * Fabric commit hook that resets EVERY Screen's shadow-node frame size whenever the root view
 * changes size. With windowSoftInputMode=adjustResize that is every keyboard open and close, not
 * only rotation. After the reset, Yoga lays the Screen out at the full stack height (the native
 * header is not subtracted) until native code re-pushes the real size:
 *  - a visible scrolled screen is laid out one header height too tall for a frame, Android clamps
 *    its scroll offset, and the offset is never restored (the bottom control ends up half behind
 *    the navigation bar);
 *  - a screen underneath a pushed screen keeps the full-height frame for good when it comes back,
 *    because its unchanged native size is deduplicated and never re-pushed (its footer sits one
 *    header height low).
 * Turning the hook off keeps the native-pushed size, which tracks rotation and window resizes on
 * its own via Screen.onLayout.
 */
import {featureFlags} from 'react-native-screens';

featureFlags.experiment.androidResetScreenShadowStateOnOrientationChangeEnabled = false;
