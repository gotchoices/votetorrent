module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^@optimystic/db-p2p$': '<rootDir>/__mocks__/@optimystic/db-p2p.js',
  },
};
