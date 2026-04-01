import Database from 'better-sqlite3';

import type { MemoryRecord, SaveMemoryInput } from './memoryTypes.js';

type MemoryRow = {
  id: number;
  kind: MemoryRecord['kind'];
  content: string;
  source: string;
  created_at: string;
};

type MemoryColumnRow = {
  name: string;
};

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        searchable_content TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.ensureSearchableContentColumn();
  }

  save(input: SaveMemoryInput): MemoryRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO memories (kind, content, searchable_content, source, created_at)
        VALUES (@kind, @content, @searchableContent, @source, @createdAt)
      `)
      .run({
        kind: input.kind,
        content: input.content,
        searchableContent: normalizeSearchText(input.content),
        source: input.source,
        createdAt
      });

    return {
      id: Number(result.lastInsertRowid),
      kind: input.kind,
      content: input.content,
      source: input.source,
      createdAt
    };
  }

  recall(query: string, limit = 5): MemoryRecord[] {
    const terms = normalizeQueryTerms(query);

    if (terms.length === 0 || limit <= 0) {
      return [];
    }

    const whereClause = terms.map(() => "searchable_content LIKE ? ESCAPE '\\'").join(' OR ');
    const rows = this.db
      .prepare(`
        SELECT id, kind, content, source, created_at
        FROM memories
        WHERE ${whereClause}
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `)
      .all(...terms.map((term) => `%${escapeLikePattern(term)}%`), limit) as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      source: row.source,
      createdAt: row.created_at
    }));
  }

  private ensureSearchableContentColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as MemoryColumnRow[];
    const hasSearchableContent = columns.some((column) => column.name === 'searchable_content');

    if (!hasSearchableContent) {
      this.db.exec('ALTER TABLE memories ADD COLUMN searchable_content TEXT');
    }

    const rows = this.db
      .prepare(`
        SELECT id, content
        FROM memories
        WHERE searchable_content IS NULL
      `)
      .all() as Array<{ id: number; content: string }>;

    const updateSearchableContent = this.db.prepare(`
      UPDATE memories
      SET searchable_content = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      updateSearchableContent.run(normalizeSearchText(row.content), row.id);
    }
  }
}

function normalizeQueryTerms(query: string): string[] {
  return [...new Set((query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map(normalizeSearchText))];
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase('vi-VN').replaceAll('Đ', 'đ');
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
