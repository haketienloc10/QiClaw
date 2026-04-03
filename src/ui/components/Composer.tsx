import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import { colors } from '../theme/colors.js';

export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  onSubmit?(value: string): void;
  isDisabled?: boolean;
}

export function Composer({ value, onChange, onSubmit, isDisabled = false }: ComposerProps) {
  return (
    <Box borderStyle="round" borderColor={colors.panelBorder} paddingX={1}>
      <Box marginRight={1}>
        <Text color={colors.textMuted}>{isDisabled ? 'Thinking' : 'Prompt'}</Text>
      </Box>
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={!isDisabled}
          placeholder={isDisabled ? 'Wait for the current turn to finish…' : 'Type a message…'}
        />
      </Box>
    </Box>
  );
}
