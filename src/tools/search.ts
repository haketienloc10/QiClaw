import { execa } from 'execa';
import * as path from 'path';
import { Tool, ToolResult } from './registry.js';

export interface SearchSnippet {
  line: number;
  content: string;
}

export interface SearchFileResult {
  filePath: string;
  matchCount: number;
  snippets: SearchSnippet[];
}

export interface SmartSearchResult {
  summary: string;
  totalMatches: number;
  files: SearchFileResult[];
  recommendedAction?: 'read_file' | 'no_need_to_read_more' | 'search_more_specific';
  suggestedFiles?: string[];
}

/**
 * Smart Search Tool - Structured + Rich Summary (Hướng 2 tối ưu)
 */
export const searchTool: Tool = {
  name: 'search',

  description: `Tìm kiếm thông minh trong toàn bộ codebase.
Trả về summary rõ ràng + structured snippets có context.
Chỉ cần 1 tool call là có đủ thông tin, giảm nhu cầu gọi readFile liên tục.`,

  // ← Phần bắt buộc: inputSchema (JSON Schema)
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Từ khóa hoặc pattern cần tìm (hỗ trợ regex)'
      },
      maxResults: {
        type: 'number',
        default: 15,
        description: 'Số kết quả tối đa trả về'
      },
      includeContext: {
        type: 'boolean',
        default: true,
        description: 'Có lấy context (6 dòng trước/sau) không'
      }
    },
    required: ['query']
  },

  execute: async (input: unknown): Promise<ToolResult> => {
    const args = input as any;
    const query = args?.query || String(input || '').trim();
    const maxResults = args?.maxResults ?? 15;
    const includeContext = args?.includeContext ?? true;

    if (!query) {
      return { content: 'Error: Missing "query" parameter' };
    }

    try {
      const result = await execa('rg', [
        '--json',
        '--context', includeContext ? '6' : '0',
        '--max-count', String(maxResults),
        query,
        '.'
      ], { cwd: process.cwd(), reject: false });

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const filesMap = new Map<string, SearchFileResult>();
      let totalMatches = 0;

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.type !== 'match') continue;

          const filePath = json.data.path.text;
          const lineNum = json.data.line_number;
          const content = json.data.lines.text.trim();

          if (!filesMap.has(filePath)) {
            filesMap.set(filePath, { filePath, matchCount: 0, snippets: [] });
          }

          const fileEntry = filesMap.get(filePath)!;
          fileEntry.matchCount++;
          totalMatches++;

          fileEntry.snippets.push({ line: lineNum, content });
        } catch (e) {}
      }

      const files = Array.from(filesMap.values())
        .sort((a, b) => b.matchCount - a.matchCount)
        .slice(0, maxResults);

      const smartResult: SmartSearchResult = {
        summary: files.length > 0
          ? `Tìm thấy ${totalMatches} matches trong ${files.length} file.\nFile quan trọng nhất: ${files.slice(0, 3).map(f => path.basename(f.filePath)).join(', ')}.`
          : `Không tìm thấy kết quả cho query: "${query}"`,
        totalMatches,
        files,
        recommendedAction: files.length === 1 && files[0].snippets.length <= 3
          ? 'no_need_to_read_more'
          : (files.length > 0 ? 'read_file' : undefined),
        suggestedFiles: files.slice(0, 3).map(f => f.filePath)
      };

      return {
        content: JSON.stringify(smartResult, null, 2)
      };

    } catch (error: any) {
      return {
        content: `Search error: ${error.message || String(error)}`
      };
    }
  }
};