import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LoadedSkill } from './registry.js';

export async function loadSkillsFromDirectory(directory: string): Promise<LoadedSkill[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const skills: LoadedSkill[] = [];

  for (const fileName of markdownFiles) {
    const filePath = join(directory, fileName);
    const raw = await readFile(filePath, 'utf8');
    skills.push(parseSkillMarkdown(raw, filePath));
  }

  return skills;
}

function parseSkillMarkdown(markdown: string, filePath: string): LoadedSkill {
  const normalizedMarkdown = normalizeLineEndings(markdown);
  const frontmatterMatch = normalizedMarkdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error(`Skill file is missing required frontmatter: ${filePath}`);
  }

  const frontmatter = parseFrontmatter(frontmatterMatch[1]);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  const instructions = frontmatterMatch[2].trim();

  if (!name || !description) {
    throw new Error(`Skill file is missing required frontmatter: ${filePath}`);
  }

  return {
    name,
    description,
    instructions
  };
}

function parseFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);

    if (!match) {
      throw new Error(`Unsupported skill frontmatter line: ${line}`);
    }

    result[match[1]] = match[2].trim();
  }

  return result;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}
