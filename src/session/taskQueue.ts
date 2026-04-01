import Database from 'better-sqlite3';

import type { TaskRecord } from '../core/types.js';

type TaskRow = {
  task_id: string;
  goal: string;
  payload_json: string;
  status: TaskRecord['status'];
  created_at: string;
  updated_at: string;
};

export class TaskQueue {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  enqueue({ taskId, goal, payloadJson }: Pick<TaskRecord, 'taskId' | 'goal' | 'payloadJson'>): void {
    this.db
      .prepare(`
        INSERT INTO tasks (task_id, goal, payload_json, status, created_at, updated_at)
        VALUES (@taskId, @goal, @payloadJson, 'pending', datetime('now'), datetime('now'))
      `)
      .run({ taskId, goal, payloadJson });
  }

  claimNext(): TaskRecord | undefined {
    const claimTask = this.db.transaction(() => {
      // The read + status transition must happen atomically so two claimers cannot
      // observe the same pending row and both mark it as running.
      const row = this.db
        .prepare(`
          SELECT task_id, goal, payload_json, status, created_at, updated_at
          FROM tasks
          WHERE status = 'pending'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        `)
        .get() as TaskRow | undefined;

      if (!row) {
        return undefined;
      }

      this.db
        .prepare("UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE task_id = ?")
        .run(row.task_id);

      const claimedRow = this.db
        .prepare(`
          SELECT task_id, goal, payload_json, status, created_at, updated_at
          FROM tasks
          WHERE task_id = ?
        `)
        .get(row.task_id) as TaskRow;

      return {
        taskId: claimedRow.task_id,
        goal: claimedRow.goal,
        payloadJson: claimedRow.payload_json,
        status: claimedRow.status,
        createdAt: claimedRow.created_at,
        updatedAt: claimedRow.updated_at
      } satisfies TaskRecord;
    });

    return claimTask();
  }
}
