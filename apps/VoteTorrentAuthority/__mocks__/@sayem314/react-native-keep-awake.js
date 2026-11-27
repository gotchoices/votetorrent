/**
 * Jest manual mock for @sayem314/react-native-keep-awake (Phase 64 plan 64-01, D-03).
 *
 * The real module is a native binding that cannot load under jest, and `transformIgnorePatterns`
 * does not transform it. useKeepAwake activates on mount and deactivates on unmount, like the
 * real hook. Never calls console.*.
 */
const React = require('react');

let active = 0;

const activateKeepAwake = jest.fn(() => {
  active += 1;
});

const deactivateKeepAwake = jest.fn(() => {
  active = Math.max(0, active - 1);
});

function useKeepAwake() {
  React.useEffect(() => {
    activateKeepAwake();
    return () => {
      deactivateKeepAwake();
    };
  }, []);
}

function KeepAwake() {
  useKeepAwake();
  return null;
}

module.exports = {
  __esModule: true,
  default: KeepAwake,
  activateKeepAwake,
  deactivateKeepAwake,
  useKeepAwake,
  __keepAwakeActiveCount() {
    return active;
  },
  __resetKeepAwakeMock() {
    active = 0;
    activateKeepAwake.mockClear();
    deactivateKeepAwake.mockClear();
  },
};
