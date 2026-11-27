/**
 * UAT 62 N2: the Election Details header read "Authority: <uuid>". It shows the authority's name
 * (passed from the election list row, which already has it) and falls back to the id only when the
 * name is absent.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ dark: false, colors: { text: '#T', textSecondary: '#TS' } }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElectionDetailsBlock } = require('../ElectionDetailsBlock');

const AUTHORITY_ID = '3628cb7e-6ea6-45ea-bb2f-79a24a52fe51';

function details() {
  return {
    election: { id: 'e1', title: 'Spring Vote', authorityId: AUTHORITY_ID, type: 0, date: Date.UTC(2026, 0, 1) },
  };
}

function authorityText(props: Record<string, unknown>): string {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<ElectionDetailsBlock electionDetails={details()} {...props} />);
  });
  return tr.root.findByProps({ testID: 'election-details-authority' }).props.children;
}

describe('ElectionDetailsBlock authority row', () => {
  it('shows the authority name when the caller knows it', () => {
    expect(authorityText({ authorityName: 'Lab Auth' })).toBe('Lab Auth');
  });

  it('falls back to the authority id when no name is given', () => {
    expect(authorityText({})).toBe(AUTHORITY_ID);
    expect(authorityText({ authorityName: '' })).toBe(AUTHORITY_ID);
  });
});
