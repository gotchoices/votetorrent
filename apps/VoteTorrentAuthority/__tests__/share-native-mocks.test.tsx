/**
 * @format
 *
 * Contract test for the three Authority native-module jest mocks (share sheet, cache-file
 * module, keep-awake; D-03/D-04). The QR view and share plans (64-17) build on these seams. The
 * `__` controls are reached only through `require()` of the mock FILE, cast to a local
 * interface: the real packages' `.d.ts` files do not declare them.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

interface ShareMock {
  __esModule: boolean;
  default: {open: (o: unknown) => Promise<{success: boolean; message: string}>};
}

interface FsMock {
  default?: unknown;
  CachesDirectoryPath: string;
  writeFile: (p: string, c: string, e?: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  unlink: (p: string) => Promise<void>;
  __fsFiles: () => Array<Record<string, unknown>>;
  __resetFsMock: () => void;
}

interface KeepAwakeMock {
  activateKeepAwake: jest.Mock;
  deactivateKeepAwake: jest.Mock;
  useKeepAwake: () => void;
  __keepAwakeActiveCount: () => number;
  __resetKeepAwakeMock: () => void;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const shareMock: ShareMock = require('../__mocks__/react-native-share.js');
const fsMock: FsMock = require('../__mocks__/@dr.pogodin/react-native-fs.js');
const keepAwakeMock: KeepAwakeMock = require('../__mocks__/@sayem314/react-native-keep-awake.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const consoleSpies = CONSOLE_METHODS.map(m => jest.spyOn(console, m).mockImplementation(() => {}));

beforeEach(() => {
  fsMock.__resetFsMock();
  keepAwakeMock.__resetKeepAwakeMock();
});

afterAll(() => {
  consoleSpies.forEach(s => s.mockRestore());
});

describe('jest loads the Authority native-module mocks', () => {
  test.each([
    'react-native-share',
    '@dr.pogodin/react-native-fs',
    '@sayem314/react-native-keep-awake',
  ])('require(%s) is the __mocks__ stand-in', name => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(name);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mock = require(`../__mocks__/${name}.js`);
    expect(loaded).toBe(mock);
  });
});

describe('share and cache-file mock seams', () => {
  test('share.open resolves success; the fs mock mirrors named exports and an in-memory cache dir', async () => {
    await expect(shareMock.default.open({url: 'file:///x'})).resolves.toEqual({
      success: true,
      message: '',
    });

    expect(fsMock.default).toBeUndefined();
    expect(typeof fsMock.CachesDirectoryPath).toBe('string');

    const path = `${fsMock.CachesDirectoryPath}/a.png`;
    await fsMock.writeFile(path, 'abc', 'base64');
    await expect(fsMock.exists(path)).resolves.toBe(true);
    const files = fsMock.__fsFiles();
    expect(files).toEqual([{path, encoding: 'base64', length: 3}]);
    expect(Object.keys(files[0])).not.toContain('contents');

    await fsMock.unlink(path);
    await expect(fsMock.exists(path)).resolves.toBe(false);
    await expect(fsMock.unlink(path)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

describe('keep-awake mock', () => {
  test('activates on mount and releases on unmount', () => {
    function Probe() {
      keepAwakeMock.useKeepAwake();
      return null;
    }
    let tr!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tr = ReactTestRenderer.create(React.createElement(Probe));
    });
    expect(keepAwakeMock.activateKeepAwake).toHaveBeenCalledTimes(1);
    expect(keepAwakeMock.__keepAwakeActiveCount()).toBe(1);

    ReactTestRenderer.act(() => {
      tr.unmount();
    });
    expect(keepAwakeMock.deactivateKeepAwake).toHaveBeenCalledTimes(1);
    expect(keepAwakeMock.__keepAwakeActiveCount()).toBe(0);
  });

  test('no mock wrote to the console', () => {
    consoleSpies.forEach(s => expect(s).not.toHaveBeenCalled());
  });
});
