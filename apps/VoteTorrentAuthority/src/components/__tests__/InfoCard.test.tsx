/**
 * InfoCard.test.tsx — shrink-and-ellipsize contract for the
 * `additionalInfo` value line, plus the image-conditional left gutter.
 *
 * Purpose: `InfoCard.tsx:45` already declares `numberOfLines={1}` on the
 * value `ThemedText`, but that alone does NOT ellipsize inside a
 * `flexDirection:'row'` sibling — React Native's Yoga defaults
 * `flexShrink: 0` on flex children (unlike the web's `1`), so the value text
 * measures at its full intrinsic width and pushes the row wider instead.
 * The fix is `flexShrink: 1` (+ `minWidth: 0`) on the value text, with the
 * label pinned to `flexShrink: 0` so only the value gives way. Separately,
 * `styles.content`'s `marginLeft: 16` stacks on top of `cardSurface`'s own
 * 16pt `paddingHorizontal` on an image-less card, producing a dead 32pt left
 * gutter — that margin is now conditional on `image` being present.
 *
 * Uses react-test-renderer ONLY. Mock header copied verbatim from
 * ChipButton.test.tsx. No i18n mock needed — InfoCard takes plain strings.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InfoCard } = require('../InfoCard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ThemedText } = require('../ThemedText');

function flattenStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

const DEVICE_HASH = 'a'.repeat(64);

describe('InfoCard — additionalInfo value shrink/ellipsize + image-conditional gutter', () => {
  it('1. value text can actually shrink: flexShrink 1, minWidth 0', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(
        <InfoCard
          title="2f3ea1b9c0d4"
          additionalInfo={[{ label: 'Device Hash', value: DEVICE_HASH }]}
        />,
      );
    });

    const valueNodes = tr.root
      .findAllByType(ThemedText)
      .filter((n) => Array.isArray(n.props.children) && n.props.children.includes(DEVICE_HASH));
    expect(valueNodes.length).toBeGreaterThan(0);
    const flat = flattenStyle(valueNodes[0]!);

    expect(flat.flexShrink).toBe(1);
    expect(flat.minWidth).toBe(0);
  });

  it('2. truncation contract still declared: numberOfLines 1, ellipsizeMode tail', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(
        <InfoCard
          title="2f3ea1b9c0d4"
          additionalInfo={[{ label: 'Device Hash', value: DEVICE_HASH }]}
        />,
      );
    });

    const valueNodes = tr.root
      .findAllByType(ThemedText)
      .filter((n) => Array.isArray(n.props.children) && n.props.children.includes(DEVICE_HASH));
    expect(valueNodes.length).toBeGreaterThan(0);
    expect(valueNodes[0]!.props.numberOfLines).toBe(1);
    expect(valueNodes[0]!.props.ellipsizeMode).toBe('tail');
  });

  it('3. the label never shrinks away: flexShrink 0', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(
        <InfoCard
          title="2f3ea1b9c0d4"
          additionalInfo={[{ label: 'Device Hash', value: DEVICE_HASH }]}
        />,
      );
    });

    const labelNodes = tr.root
      .findAllByType(ThemedText)
      .filter((n) => n.props.children === 'Device Hash');
    expect(labelNodes.length).toBeGreaterThan(0);
    const flat = flattenStyle(labelNodes[0]!);
    expect(flat.flexShrink).toBe(0);
  });

  it('4. left gutter is image-conditional: marginLeft 0 without image, 16 with image', () => {
    let noImageTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      noImageTr = renderer.create(
        <InfoCard title="No Image Card" additionalInfo={[{ label: 'Peer ID', value: '123' }]} />,
      );
    });
    const noImageContent = noImageTr.root.findByType(require('react-native').View);
    // The content View is the first View child of the TouchableOpacity when
    // no image renders — locate it by its flex:1 + the infoText descendant
    // rather than positional indexing, which would break if the image
    // conditionally inserts/removes a sibling.
    const noImageCandidates = noImageTr.root.findAll((n) => {
      if (n.type !== require('react-native').View) return false;
      const flat = StyleSheet.flatten(n.props.style) as Record<string, unknown> | undefined;
      return !!flat && flat.flex === 1;
    });
    expect(noImageCandidates.length).toBeGreaterThan(0);
    const noImageFlat = flattenStyle(noImageCandidates[0]!);
    expect(noImageFlat.marginLeft).toBe(0);

    let withImageTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      withImageTr = renderer.create(
        <InfoCard
          image={{ uri: 'x' } as unknown as never}
          title="With Image Card"
          additionalInfo={[{ label: 'Peer ID', value: '123' }]}
        />,
      );
    });
    const withImageCandidates = withImageTr.root.findAll((n) => {
      if (n.type !== require('react-native').View) return false;
      const flat = StyleSheet.flatten(n.props.style) as Record<string, unknown> | undefined;
      return !!flat && flat.flex === 1;
    });
    expect(withImageCandidates.length).toBeGreaterThan(0);
    const withImageFlat = flattenStyle(withImageCandidates[0]!);
    expect(withImageFlat.marginLeft).toBe(16);

    void noImageContent;
  });

  it('5. the card still constrains its own content: flex 1 + minWidth 0', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(
        <InfoCard title="Card" additionalInfo={[{ label: 'Peer ID', value: '123' }]} />,
      );
    });
    const candidates = tr.root.findAll((n) => {
      if (n.type !== require('react-native').View) return false;
      const flat = StyleSheet.flatten(n.props.style) as Record<string, unknown> | undefined;
      return !!flat && flat.flex === 1;
    });
    expect(candidates.length).toBeGreaterThan(0);
    const flat = flattenStyle(candidates[0]!);
    expect(flat.flex).toBe(1);
    expect(flat.minWidth).toBe(0);
  });

  it('6. title untouched: still numberOfLines 1, renders the exact string passed in', () => {
    const fullHash = 'b'.repeat(64);
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<InfoCard title={fullHash} />);
    });

    const titleNodes = tr.root.findAllByType(ThemedText).filter((n) => n.props.children === fullHash);
    expect(titleNodes.length).toBeGreaterThan(0);
    expect(titleNodes[0]!.props.numberOfLines).toBe(1);
  });
});

describe('InfoCard — optional onIconPress (a Find card opens on body tap; the icon is its own 44pt button)', () => {
  function render(props: Record<string, unknown>) {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<InfoCard title="Card" icon="thumbtack" {...props} />);
    });
    return tr;
  }
  const { TouchableOpacity } = require('react-native');

  it('7. icon press calls onIconPress and not onPress; body press calls onPress', () => {
    const onPress = jest.fn();
    const onIconPress = jest.fn();
    const tr = render({ onPress, onIconPress, iconAccessibilityLabel: 'Pin' });
    const iconBtn = tr.root.findByProps({ accessibilityLabel: 'Pin' });
    renderer.act(() => iconBtn.props.onPress());
    expect(onIconPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();

    const outer = tr.root.findAllByType(TouchableOpacity)[0]!;
    renderer.act(() => outer.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onIconPress).toHaveBeenCalledTimes(1);
  });

  it('8. the icon target is at least 44x44 and is a labelled button', () => {
    const tr = render({ onPress: jest.fn(), onIconPress: jest.fn(), iconAccessibilityLabel: 'Pin' });
    const iconBtn = tr.root.findByProps({ accessibilityLabel: 'Pin' });
    expect(iconBtn.props.accessibilityRole).toBe('button');
    const flat = StyleSheet.flatten(iconBtn.props.style) as Record<string, number>;
    expect(flat.minWidth).toBeGreaterThanOrEqual(44);
    expect(flat.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('9. without onIconPress the glyph renders bare (no nested button)', () => {
    const tr = render({ onPress: jest.fn() });
    expect(tr.root.findAllByType(TouchableOpacity)).toHaveLength(1);
  });
});
