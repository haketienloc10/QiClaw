import React from 'react';
import { Box, Text } from 'ink';

import type { ChatSessionRecord } from '../../core/types.js';
import { colors } from '../theme/colors.js';

export interface SidebarProps {
  sessions: ChatSessionRecord[];
  activeSessionId?: string;
}

export function Sidebar({ sessions, activeSessionId }: SidebarProps) {
  return (
    <Box flexDirection="column" width={32} borderStyle="round" borderColor={colors.panelBorder} paddingX={1}>
      <Text color={colors.text} bold>
        Chats
      </Text>
      {sessions.length === 0 ? (
        <Text color={colors.textMuted}>No chats yet</Text>
      ) : (
        sessions.map((session) => (
          <Box key={session.sessionId} flexDirection="column" marginTop={1}>
            <Text color={session.sessionId === activeSessionId ? colors.accent : colors.text}>
              {session.title}
            </Text>
            <Text color={colors.textMuted}>{session.model}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
