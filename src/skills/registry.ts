export interface LoadedSkill {
  name: string;
  description: string;
  instructions: string;
}

export class SkillRegistry {
  private readonly skillsByName: Map<string, LoadedSkill>;

  constructor(skills: LoadedSkill[]) {
    this.skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  }

  getByName(name: string): LoadedSkill | undefined {
    return this.skillsByName.get(name);
  }
}
