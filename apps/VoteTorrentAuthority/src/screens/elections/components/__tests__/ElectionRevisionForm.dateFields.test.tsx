/**
 * Co-located test for `ElectionRevisionForm`'s ten `DateField` rows (D-16,
 * Phase 59 plan 04) — pins two things:
 *
 *   1. Rendered order: the ten rows render in D-09 chronological order,
 *      derived from `TIMELINE_FIELD_ORDER` (task 1's module), not a
 *      hand-typed literal — so this test cannot silently drift from the
 *      `ElectionEvent` enum it is meant to track.
 *   2. Per-field binding: invoking the Nth row's `onChange` emits a form
 *      value whose Nth field — and only that field — changed. This is the
 *      copy-paste gate: a duplicated `set({ votingStarts: v })` mistakenly
 *      left under the `accruingVotes` row fails HERE and nowhere else.
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app. Harness mirrors
 * `AttestationPolicySection.test.tsx`: identity `t` mock, sentinel
 * `PALETTE` through a mocked `@react-navigation/native`, and
 * `react-native-vector-icons/FontAwesome6` + `@react-native-community/
 * datetimepicker` both mocked to plain string components (DateField loads
 * the picker at module scope).
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality (e.g. two tokens sharing the same hex).
const PALETTE = {
  text: '#T',
  textSecondary: '#TS',
  success: '#SU',
  warning: '#WA',
  error: '#ER',
  accent: '#AC',
  card: '#CA',
  background: '#BG',
  border: '#BO',
  dark: '#DA',
  light: '#LI',
  primary: '#PR',
  notification: '#NO',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: PALETTE,
  }),
}));

import { ElectionRevisionForm, ElectionRevisionFormValue } from '../ElectionRevisionForm';
import { DateField } from '../../../../components/DateField';
import { TIMELINE_FIELD_ORDER } from '../../resolve-election-timeline';

const BASE_VALUE: ElectionRevisionFormValue = {
  registrationEnds: '',
  ballotsFinal: '',
  votingStarts: '',
  accruingVotes: '',
  hashingVotes: '',
  releasingKeys: '',
  tallyingStarts: '',
  validation: '',
  certificationStarts: '',
  closed: '',
  keyholders: [],
  threshold: 1,
  tags: [],
  instructions: '',
};

describe('ElectionRevisionForm — ten DateField rows (D-16)', () => {
  it('renders exactly ten DateFields whose titles are the ElectionEvent members in D-09 order', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<ElectionRevisionForm value={BASE_VALUE} onChange={() => {}} />);
    });

    const dateFields = tr.root.findAllByType(DateField);
    const titles = dateFields.map((n) => n.props.title);

    // TIMELINE_FIELD_ORDER members are ElectionEvent string-enum values,
    // which equal their own key names — and the identity t() mock makes
    // each title prop equal the i18n key passed to t(). So the rendered
    // title sequence must deep-equal TIMELINE_FIELD_ORDER as plain strings.
    expect(titles).toEqual(TIMELINE_FIELD_ORDER.map((event) => String(event)));
    expect(dateFields).toHaveLength(10);
  });

  it('invoking the Nth DateField onChange emits a form value whose Nth field — and only that field — changed', () => {
    for (let i = 0; i < TIMELINE_FIELD_ORDER.length; i++) {
      const fieldName = String(TIMELINE_FIELD_ORDER[i]) as keyof ElectionRevisionFormValue;
      let latest: ElectionRevisionFormValue | null = null;
      const onChange = (next: ElectionRevisionFormValue) => {
        latest = next;
      };

      let tr!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tr = renderer.create(<ElectionRevisionForm value={BASE_VALUE} onChange={onChange} />);
      });

      const dateFields = tr.root.findAllByType(DateField);
      const sentinel = `sentinel-${fieldName}`;
      renderer.act(() => {
        dateFields[i].props.onChange(sentinel);
      });

      expect(latest).not.toBeNull();
      const emitted = latest as unknown as ElectionRevisionFormValue;
      // Only the Nth field changed from BASE_VALUE.
      for (const key of Object.keys(BASE_VALUE) as Array<keyof ElectionRevisionFormValue>) {
        if (key === fieldName) {
          expect(emitted[key]).toBe(sentinel);
        } else {
          expect(emitted[key]).toEqual(BASE_VALUE[key]);
        }
      }
    }
  });
});
