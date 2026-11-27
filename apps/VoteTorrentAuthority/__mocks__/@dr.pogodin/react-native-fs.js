/**
 * Jest manual mock for @dr.pogodin/react-native-fs (Phase 64 plan 64-01, D-04).
 *
 * The real module is a native binding that cannot load under jest, and `transformIgnorePatterns`
 * does not transform it. NAMED exports only, with no default, mirroring the real module, so a
 * default-import mistake fails under jest exactly as it would on a device. Files live in memory.
 * `__fsFiles()` reports path, encoding and length only, never the contents. Never calls console.*.
 */
const files = new Map();

function enoent(path) {
  const error = new Error(`ENOENT: no such file or directory, unlink '${path}'`);
  error.code = 'ENOENT';
  return error;
}

const writeFile = jest.fn((path, contents, encoding) => {
  files.set(path, {encoding, length: String(contents).length});
  return Promise.resolve();
});

const exists = jest.fn(path => Promise.resolve(files.has(path)));

const unlink = jest.fn(path => {
  if (!files.has(path)) {
    return Promise.reject(enoent(path));
  }
  files.delete(path);
  return Promise.resolve();
});

const mkdir = jest.fn(() => Promise.resolve());

module.exports = {
  __esModule: true,
  CachesDirectoryPath: '/mock/caches',
  DocumentDirectoryPath: '/mock/documents',
  TemporaryDirectoryPath: '/mock/tmp',
  writeFile,
  exists,
  unlink,
  mkdir,
  __fsFiles() {
    return Array.from(files, ([path, meta]) => ({
      path,
      encoding: meta.encoding,
      length: meta.length,
    }));
  },
  __resetFsMock() {
    files.clear();
    [writeFile, exists, unlink, mkdir].forEach(fn => fn.mockClear());
  },
};
