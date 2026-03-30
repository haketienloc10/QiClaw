import Database from 'better-sqlite3';

import type { CheckpointRecord, TaskStatus } from '../core/types.js';

type CheckpointRow = {
  session_id: string;
  task_id: string;
  status: TaskStatus;
  checkpoint_json: string;
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
      )
    `);
  }

  save(record: CheckpointRecord): void {
    this.db
      .prepare(`
        INSERT INTO checkpoints (session_id, task_id, status, checkpoint_json, updated_at)
        VALUES (@sessionId, @taskId, @status, @checkpointJson, datetime('now'))
        ON CONFLICT(session_id) DO UPDATE SET
          task_id = excluded.task_id,
          status = excluded.status,
          checkpoint_json = excluded.checkpoint_json,
          updated_at = datetime('now')
      `)
      .run(record);
  }

  getBySessionId(sessionId: string): CheckpointRecord | undefined {
    const row = this.db
      .prepare('SELECT session_id, task_id, status, checkpoint_json, updated_at FROM checkpoints WHERE session_id = ?')
      .get(sessionId) as CheckpointRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      status: row.status,
      checkpointJson: row.checkpoint_json,
      updatedAt: row.updated_at
    };
  }
}
