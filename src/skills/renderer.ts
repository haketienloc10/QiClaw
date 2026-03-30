import type { LoadedSkill } from './registry.js';

export function renderSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  return [
    'Skills:',
    ...skills.flatMap((skill) => [
      `- ${skill.name}: ${skill.description}`,
      ...renderIndentedInstructions(skill.instructions)
    ])
  ].join('\n');
}

function renderIndentedInstructions(instructions: string): string[] {
  return instructions.split('\n').map((line) => `  ${line}`);
}
