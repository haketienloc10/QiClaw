import Database from 'better-sqlite3';

import type { ChatSessionRecord, CheckpointRecord, TaskStatus } from '../core/types.js';
import { parseInteractiveCheckpointJson } from './session.js';

type CheckpointRow = {
  session_id: string;
  task_id: string;
  status: TaskStatus;
  checkpoint_json: string;
  updated_at: string;
};

type ChatSessionRow = {
  session_id: string;
  title: string;
  provider: 'anthropic' | 'openai';
  model: string;
  created_at: string;
  updated_at: string;
};

export class CheckpointStore {
  private readonly db: Database.Database;

  // Stores the latest checkpoint for each session. taskId is retained as metadata
  // about the task active at the time that session-level checkpoint was saved.

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  save(record: CheckpointRecord): void {
    const updatedAt = record.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO checkpoints (session_id, task_id, status, checkpoint_json, updated_at)
        VALUES (@sessionId, @taskId, @status, @checkpointJson, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          task_id = excluded.task_id,
          status = excluded.status,
          checkpoint_json = excluded.checkpoint_json,
          updated_at = excluded.updated_at
      `)
      .run({ ...record, updatedAt });
  }

  getBySessionId(sessionId: string): CheckpointRecord | undefined {
    const row = this.db
      .prepare('SELECT session_id, task_id, status, checkpoint_json, updated_at FROM checkpoints WHERE session_id = ?')
      .get(sessionId) as CheckpointRow | undefined;

    return row ? toCheckpointRecord(row) : undefined;
  }

  getLatest(): CheckpointRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT session_id, task_id, status, checkpoint_json, updated_at
        FROM checkpoints
        ORDER BY updated_at DESC, session_id DESC
        LIMIT 1
      `)
      .get() as CheckpointRow | undefined;

    return row ? toCheckpointRecord(row) : undefined;
  }

  createChatSession(record: Pick<ChatSessionRecord, 'sessionId' | 'title' | 'provider' | 'model'>): ChatSessionRecord {
    const timestamp = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO chat_sessions (session_id, title, provider, model, created_at, updated_at)
        VALUES (@sessionId, @title, @provider, @model, @createdAt, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title,
          provider = excluded.provider,
          model = excluded.model,
          updated_at = excluded.updated_at
      `)
      .run({
        ...record,
        createdAt: timestamp,
        updatedAt: timestamp
      });

    return this.getChatSession(record.sessionId)!;
  }

  getChatSession(sessionId: string): ChatSessionRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT session_id, title, provider, model, created_at, updated_at
        FROM chat_sessions
        WHERE session_id = ?
      `)
      .get(sessionId) as ChatSessionRow | undefined;

    return row ? toChatSessionRecord(row) : undefined;
  }

  listChatSessions(): ChatSessionRecord[] {
    return this.db
      .prepare(`
        SELECT session_id, title, provider, model, created_at, updated_at
        FROM chat_sessions
        ORDER BY updated_at DESC, session_id DESC
      `)
      .all()
      .map((row) => toChatSessionRecord(row as ChatSessionRow));
  }

  renameChatSession(sessionId: string, title: string): void {
    this.db
      .prepare(`
        UPDATE chat_sessions
        SET title = ?, updated_at = ?
        WHERE session_id = ?
      `)
      .run(title, new Date().toISOString(), sessionId);
  }

  touchChatSession(sessionId: string, updates: Partial<Pick<ChatSessionRecord, 'provider' | 'model'>> = {}): void {
    const existing = this.getChatSession(sessionId);
    if (!existing) {
      return;
    }

    this.db
      .prepare(`
        UPDATE chat_sessions
        SET provider = ?, model = ?, updated_at = ?
        WHERE session_id = ?
      `)
      .run(
        updates.provider ?? existing.provider,
        updates.model ?? existing.model,
        new Date().toISOString(),
        sessionId
      );
  }

  deleteChatSession(sessionId: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE session_id = ?').run(sessionId);
  }

  importLatestLegacyCheckpointAsChat(): ChatSessionRecord | undefined {
    const latest = this.getLatest();
    if (!latest) {
      return undefined;
    }

    const existing = this.getChatSession(latest.sessionId);
    if (existing) {
      return existing;
    }

    const parsed = parseInteractiveCheckpointJson(latest.checkpointJson);
    const firstUserMessage = parsed?.history.find((message) => message.role === 'user')?.content.trim();
    const title = firstUserMessage && firstUserMessage.length > 0 ? firstUserMessage : 'Imported Chat';

    this.db
      .prepare(`
        INSERT INTO chat_sessions (session_id, title, provider, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(latest.sessionId, title, 'anthropic', 'claude-opus-4-6', latest.updatedAt, latest.updatedAt);

    return this.getChatSession(latest.sessionId);
  }
}

function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    status: row.status,
    checkpointJson: row.checkpoint_json,
    updatedAt: row.updated_at
  };
}

function toChatSessionRecord(row: ChatSessionRow): ChatSessionRecord {
  return {
    sessionId: row.session_id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
