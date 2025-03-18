import React from 'react';
import {StyleSheet, TouchableOpacity, View} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ThemedText} from './ThemedText';
import {ExtendedTheme, useTheme} from '@react-navigation/native';

interface ChipButtonProps {
  label: string;
  icon?: string;
  onPress?: () => void;
}

export function ChipButton({label, icon, onPress}: ChipButtonProps) {
  const {colors} = useTheme() as ExtendedTheme;

  return (
    <TouchableOpacity
      // This is using onPressIn because of a bug with onPress in headers
      onPressIn={onPress}
      style={[styles.container, {backgroundColor: colors.accent}]}>
      <ThemedText>{label}</ThemedText>
      {icon && (
        <FontAwesome6
          name={icon}
          size={14}
          color={colors.text}
          style={styles.icon}
        />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  icon: {
    marginLeft: 6,
  },
});
