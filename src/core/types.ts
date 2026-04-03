export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  isError?: boolean;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
  }>;
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
}

export interface ChatSessionRecord {
  sessionId: string;
  title: string;
  provider: 'anthropic' | 'openai';
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRecord {
  sessionId: string;
  taskId: string;
  status: TaskStatus;
  checkpointJson: string;
  updatedAt?: string;
}

export interface TaskRecord {
  taskId: string;
  goal: string;
  payloadJson: string;
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
}
