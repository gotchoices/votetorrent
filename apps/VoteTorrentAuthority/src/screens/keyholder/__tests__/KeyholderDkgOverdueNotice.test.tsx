/**
 * KeyholderDkgOverdueNotice.test.tsx: informational overdue notice, no touchable element.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import { KeyholderDkgOverdueNotice } from '../components/KeyholderDkgOverdueNotice';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { hours?: number; names?: string }) => (o ? `${key}|${o.hours}|${o.names}` : key),
  }),
}));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: { textSecondary: '#888', warning: '#FA0' } }),
}));

function render(labels: string[], hours = 24) {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<KeyholderDkgOverdueNotice labels={labels} hours={hours} />);
  });
  return tr;
}

describe('KeyholderDkgOverdueNotice', () => {
  it('N1 renders the notice and the help line', () => {
    const tr = render(['Bea']);
    expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-dkg-overdue-notice').length).toBeGreaterThan(0);
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('dkgOverdueNotice|24|Bea');
    expect(json).toContain('dkgOverdueHelp');
  });
  it('N1b joins names with a comma', () => {
    expect(JSON.stringify(render(['Ana', 'Bea']).toJSON())).toContain('dkgOverdueNotice|24|Ana, Bea');
  });
  it('N1c renders null for no labels', () => {
    expect(render([]).toJSON()).toBeNull();
  });
  it('N2 has no touchable element', () => {
    const tr = render(['Bea']);
    expect(tr.root.findAll((n) => typeof n.props?.onPress === 'function')).toHaveLength(0);
  });
});
