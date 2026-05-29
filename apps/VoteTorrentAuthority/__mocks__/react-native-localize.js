/**
 * @format
 *
 * Phase 11 plan 11-01 (D-12) — Jest mock for react-native-localize.
 * Allows i18n-parity.test.ts to import resources without native module errors.
 */
module.exports = {
  getLocales: () => [{ languageCode: 'en', countryCode: 'US' }],
  getNumberFormatSettings: () => ({ decimalSeparator: '.', groupingSeparator: ',' }),
  getCalendar: () => 'gregorian',
  getCountry: () => 'US',
  getCurrencies: () => ['USD'],
  getTemperatureUnit: () => 'celsius',
  getTimeZone: () => 'America/New_York',
  uses24HourClock: () => true,
  usesMetricSystem: () => true,
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
  findBestLanguageTag: () => ({ languageTag: 'en-US', isRTL: false }),
};
