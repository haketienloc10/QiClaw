import React from 'react';
import { Box, Text } from 'ink';

import { colors } from '../theme/colors.js';

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <Box justifyContent={isUser ? 'flex-end' : 'flex-start'} marginBottom={1}>
      <Box width="80%" borderStyle="round" borderColor={isUser ? colors.user : colors.accent} paddingX={1}>
        <Text color={isUser ? colors.user : colors.text}>{content}</Text>
      </Box>
    </Box>
  );
}
