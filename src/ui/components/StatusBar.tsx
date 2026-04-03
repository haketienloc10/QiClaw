import React from 'react';
import { Box, Text } from 'ink';

import type { ProviderUsageSummary } from '../../provider/model.js';
import { colors } from '../theme/colors.js';

export interface StatusBarProps {
  model: string;
  usage?: ProviderUsageSummary;
  statusText?: string;
  toolCount?: number;
}

export function StatusBar({ model, usage, statusText, toolCount = 0 }: StatusBarProps) {
  const usageParts = [
    usage?.inputTokens !== undefined ? `In ${usage.inputTokens}` : undefined,
    usage?.outputTokens !== undefined ? `Out ${usage.outputTokens}` : undefined,
    usage?.totalTokens !== undefined ? `Total ${usage.totalTokens}` : undefined
  ].filter((part): part is string => part !== undefined);

  return (
    <Box borderStyle="round" borderColor={colors.panelBorder} paddingX={1}>
      <Text>
        Model: {model}
        {usageParts.length > 0 ? ` | ${usageParts.join(' | ')}` : ''}
        {statusText ? ` | ${statusText}` : ''}
        {toolCount > 0 ? ` | Tools ${toolCount}` : ''}
      </Text>
    </Box>
  );
}
