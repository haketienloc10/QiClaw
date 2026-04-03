import React from 'react';
import { Box, Text } from 'ink';

import type { Message } from '../../core/types.js';
import type { ToolActivityItem } from '../App.js';
import { colors } from '../theme/colors.js';
import { MessageBubble } from './MessageBubble.js';

export interface ChatPaneProps {
  messages: Message[];
  toolActivities?: ToolActivityItem[];
}

export function ChatPane({ messages, toolActivities = [] }: ChatPaneProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold>Conversation</Text>
      <Box flexDirection="column" marginTop={1}>
        {messages.filter((message) => message.role === 'user' || message.role === 'assistant').map((message, index) => (
          <MessageBubble key={`${message.role}-${index}`} role={message.role as 'user' | 'assistant'} content={message.content} />
        ))}
      </Box>
      {toolActivities.length > 0 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.panelBorder} paddingX={1}>
          <Text bold>Activity</Text>
          {toolActivities.map((activity, index) => (
            <Text key={`${activity.id}-${index}`} color={activity.status === 'completed' ? colors.success : colors.accent}>
              {activity.status === 'completed' ? 'done' : 'run'} {activity.name}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
