import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSkillsFromDirectory } from '../../src/skills/loader.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { renderSkillsForPrompt } from '../../src/skills/renderer.js';

describe('loadSkillsFromDirectory', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('loads markdown skills with strict frontmatter in deterministic file order', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'skill-loader-'));
    tempDirs.push(tempDir);

    const skillsDir = join(tempDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    await writeFile(join(skillsDir, 'b-review.md'), `---\nname: review\ndescription: Review implementation changes carefully.\n---\nCheck tests, scope, and regressions.\n`);
    await writeFile(join(skillsDir, 'a-tdd.md'), `---\nname: tdd\ndescription: Follow red-green-refactor.\n---\nWrite a failing test first.\n`);

    const skills = await loadSkillsFromDirectory(skillsDir);

    expect(skills).toEqual([
      {
        name: 'tdd',
        description: 'Follow red-green-refactor.',
        instructions: 'Write a failing test first.'
      },
      {
        name: 'review',
        description: 'Review implementation changes carefully.',
        instructions: 'Check tests, scope, and regressions.'
      }
    ]);
  });

  it('loads markdown skills with CRLF frontmatter and body', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'skill-loader-'));
    tempDirs.push(tempDir);

    const skillsDir = join(tempDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    await writeFile(join(skillsDir, 'windows.md'), `---\r\nname: windows\r\ndescription: Accept CRLF line endings.\r\n---\r\nKeep parsing deterministic.\r\nSecond line.\r\n`);

    await expect(loadSkillsFromDirectory(skillsDir)).resolves.toEqual([
      {
        name: 'windows',
        description: 'Accept CRLF line endings.',
        instructions: 'Keep parsing deterministic.\nSecond line.'
      }
    ]);
  });

  it('throws when required frontmatter fields are missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'skill-loader-'));
    tempDirs.push(tempDir);

    const skillsDir = join(tempDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'broken.md'), `---\nname: broken\n---\nMissing description.\n`);

    await expect(loadSkillsFromDirectory(skillsDir)).rejects.toThrow('Skill file is missing required frontmatter');
  });
});

describe('SkillRegistry', () => {
  it('looks up a skill by exact name', () => {
    const registry = new SkillRegistry([
      {
        name: 'tdd',
        description: 'Follow red-green-refactor.',
        instructions: 'Write a failing test first.'
      },
      {
        name: 'review',
        description: 'Review implementation changes carefully.',
        instructions: 'Check tests, scope, and regressions.'
      }
    ]);

    expect(registry.getByName('review')).toEqual({
      name: 'review',
      description: 'Review implementation changes carefully.',
      instructions: 'Check tests, scope, and regressions.'
    });
    expect(registry.getByName('missing')).toBeUndefined();
  });
});

describe('renderSkillsForPrompt', () => {
  it('renders selected skills into deterministic prompt text', () => {
    expect(renderSkillsForPrompt([
      {
        name: 'tdd',
        description: 'Follow red-green-refactor.',
        instructions: 'Write a failing test first.'
      },
      {
        name: 'review',
        description: 'Review implementation changes carefully.',
        instructions: 'Check tests, scope, and regressions.'
      }
    ])).toBe([
      'Skills:',
      '- tdd: Follow red-green-refactor.',
      '  Write a failing test first.',
      '- review: Review implementation changes carefully.',
      '  Check tests, scope, and regressions.'
    ].join('\n'));
  });

  it('indents each instruction line for multiline skills', () => {
    expect(renderSkillsForPrompt([
      {
        name: 'debug',
        description: 'Debug carefully.',
        instructions: 'Step one.\nStep two.\n- Keep evidence.'
      }
    ])).toBe([
      'Skills:',
      '- debug: Debug carefully.',
      '  Step one.',
      '  Step two.',
      '  - Keep evidence.'
    ].join('\n'));
  });

  it('returns an empty string when there are no skills to render', () => {
    expect(renderSkillsForPrompt([])).toBe('');
  });
});
