# Agent Prompt Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor agent packages so `agent.json` declares `promptFiles: string[]`, runtime assembles a final prompt from markdown files in manifest order, and all `AgentSpec`-style structured prompt extraction is removed.

**Architecture:** The refactor keeps runtime-enforced metadata (`policy`, `completion`, `diagnostics`) in `agent.json`, but replaces slot-based prompt parsing with filename-based prompt assembly. Package loading collects all `.md` files by filename, package resolution merges `promptFiles` with parent-first append-child semantics, and runtime/preview consumers render from `effectivePromptOrder` plus a filename-keyed prompt file map.

**Tech Stack:** TypeScript, Node.js, Vitest, existing QiClaw agent runtime modules

---

## File Structure

**Modify:**
- `src/agent/spec.ts` — remove slot-based and `AgentSpec` prompt types; add filename-based prompt manifest/resolution types
- `src/agent/packageLoader.ts` — load all `.md` files by filename and keep them in a generic map
- `src/agent/packageValidator.ts` — validate `manifest.promptFiles`, referenced files, and resolved prompt order
- `src/agent/packageResolver.ts` — merge prompt order parent-first and build resolved prompt file map/order
- `src/agent/specPrompt.ts` — render prompt by `effectivePromptOrder`
- `src/agent/packagePreview.ts` — preview prompt files by ordered filename list instead of slot names
- `src/agent/specRegistry.ts` — remove `AgentSpec` derivation/parsing and inline-compile path; keep builtin package resolution/listing only
- `src/agent/runtime.ts` — remove `agentSpec` usage and rely on `ResolvedAgentPackage`
- `src/agent/loop.ts` — remove `agentSpec` fallback for completion/context flags
- `src/cli/main.ts` — update spec preview output to show ordered prompt files
- `src/agent/builtin-packages/default/agent.json` — add `promptFiles`
- `src/agent/builtin-packages/readonly/agent.json` — add `promptFiles`

**Create:**
- `tests/agent/packageLoader.test.ts` — verifies `.md` discovery and manifest validation
- `tests/agent/packageResolver.test.ts` — verifies parent-first prompt order merge and resolved file list
- `tests/agent/specPrompt.test.ts` — verifies rendered prompt order
- `tests/agent/runtime.test.ts` — verifies runtime no longer depends on `AgentSpec`

---

### Task 1: Replace slot-based types with filename-based prompt package types

**Files:**
- Modify: `src/agent/spec.ts`
- Modify: `src/agent/specRegistry.ts`
- Test: `tests/agent/runtime.test.ts`

- [ ] **Step 1: Write the failing runtime/type-level test**

```ts
import { describe, expect, it } from 'vitest';

import { createAgentRuntime } from '../../src/agent/runtime.js';

describe('createAgentRuntime', () => {
  it('creates a runtime from a resolved package without agentSpec metadata', () => {
    const runtime = createAgentRuntime({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      cwd: '/tmp/project',
      resolvedPackage: {
        preset: 'inline',
        sourceTier: 'builtin',
        extendsChain: ['inline'],
        packageChain: [],
        effectivePolicy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 1,
          mutationMode: 'none',
          includeMemory: true,
          includeSkills: true,
          includeHistorySummary: true
        },
        effectiveCompletion: {
          completionMode: 'single-turn',
          doneCriteriaShape: 'substantive answer',
          evidenceRequirement: 'use direct evidence',
          stopVsDoneDistinction: 'stop is not done'
        },
        effectiveDiagnostics: undefined,
        effectivePromptFiles: {
          'base.md': { filePath: '/tmp/project/base.md', content: '# Base' }
        },
        effectivePromptOrder: ['base.md'],
        resolvedFiles: ['/tmp/project/base.md']
      }
    });

    expect(runtime.agentSpec).toBeUndefined();
    expect(runtime.systemPrompt).toContain('# Base');
    expect(runtime.maxToolRounds).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/runtime.test.ts`
Expected: FAIL with TypeScript/runtime errors because `ResolvedAgentPackage` does not have `effectivePromptOrder` and `createAgentRuntime` still references `AgentSpec`.

- [ ] **Step 3: Rewrite prompt-related types in `src/agent/spec.ts`**

Replace the slot-based prompt/type section with this structure:

```ts
export type AgentCapabilityClass = 'read' | 'write' | 'search' | 'exec_readonly' | 'execute';
export type AgentPackageSourceTier = 'project' | 'user' | 'builtin';
export type AgentPromptFileName = string;
export type AgentMutationMode = 'none' | 'workspace-write';
export type AgentDiagnosticsParticipationLevel = 'none' | 'normal' | 'trace-oriented' | 'audit-oriented';
export type AgentRedactionSensitivity = 'standard' | 'standard-to-high' | 'high';

export interface AgentRuntimePolicy {
  allowedCapabilityClasses?: AgentCapabilityClass[];
  maxToolRounds?: number;
  requiresToolEvidence?: boolean;
  requiresSubstantiveFinalAnswer?: boolean;
  forbidSuccessAfterToolErrors?: boolean;
  mutationMode?: AgentMutationMode;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeHistorySummary?: boolean;
  diagnosticsParticipationLevel?: AgentDiagnosticsParticipationLevel;
  redactionSensitivity?: AgentRedactionSensitivity;
}

export interface AgentCompletionMetadata {
  completionMode?: string;
  doneCriteriaShape?: string;
  evidenceRequirement?: string;
  stopVsDoneDistinction?: string;
}

export interface AgentPackageDiagnosticsManifest {
  traceabilityExpectation?: string;
}

export interface AgentPackageManifest {
  extends?: string;
  promptFiles?: AgentPromptFileName[];
  policy?: AgentRuntimePolicy;
  completion?: AgentCompletionMetadata;
  diagnostics?: AgentPackageDiagnosticsManifest;
}

export interface AgentPromptFile {
  filePath: string;
  content: string;
}

export interface LoadedAgentPackage {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  directoryPath: string;
  manifestPath: string;
  manifest?: AgentPackageManifest;
  promptFiles: Record<AgentPromptFileName, AgentPromptFile>;
}

export interface ResolvedAgentPackage {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  packageChain: LoadedAgentPackage[];
  effectivePolicy: AgentRuntimePolicy;
  effectiveCompletion?: AgentPackageManifest['completion'];
  effectiveDiagnostics?: AgentPackageManifest['diagnostics'];
  effectivePromptFiles: Record<AgentPromptFileName, AgentPromptFile>;
  effectivePromptOrder: AgentPromptFileName[];
  resolvedFiles: string[];
}

export interface AgentCompletionSpec {
  completionMode: string;
  doneCriteriaShape: string;
  evidenceRequirement: string;
  stopVsDoneDistinction: string;
  maxToolRounds: number;
  requiresToolEvidence?: boolean;
  requiresSubstantiveFinalAnswer?: boolean;
  forbidSuccessAfterToolErrors?: boolean;
}

export interface AgentPackagePreview {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  promptFiles: Array<{ fileName: string; filePath: string }>;
  resolvedFiles: string[];
  effectiveRuntimePolicy: AgentRuntimePolicy;
  renderedPromptText: string;
}
```

- [ ] **Step 4: Remove `AgentSpec` registry code from `src/agent/specRegistry.ts`**

Delete:
- `getBuiltinAgentSpec`
- `resolveAgentPackage(options?: { agentSpec?: AgentSpec; agentSpecName?: string })`
- `deriveAgentSpecFromResolvedPackage`
- `readLineValue`
- `readOptionalLineValue`
- `compileResolvedAgentPackage`
- `buildPromptFiles`

Keep only builtin preset discovery and builtin package resolution:

```ts
export type BuiltinAgentSpecName = 'default' | 'readonly';

export function resolveBuiltinAgentPackage(name: string): ResolvedAgentPackage {
  return resolveBuiltinAgentPackageWithStack(name, []);
}

export function getDefaultAgentSpecName(): BuiltinAgentSpecName {
  return 'default';
}

export function listBuiltinAgentSpecNames(): BuiltinAgentSpecName[] {
  return [...builtinAgentSpecNames];
}
```

And change resolved package assembly to carry these fields:

```ts
const effectivePromptFiles = {
  ...(parentPackage?.effectivePromptFiles ?? {}),
  ...loaded.promptFiles
};
const effectivePromptOrder = [
  ...(parentPackage?.effectivePromptOrder ?? []),
  ...(loaded.manifest?.promptFiles ?? [])
];
```

- [ ] **Step 5: Update `src/agent/runtime.ts` to drop `agentSpec` inputs and state**

Change the top-level imports and interfaces to this shape:

```ts
import { createProvider } from '../provider/factory.js';
import type { ModelProvider, ResolvedProviderConfig } from '../provider/model.js';
import { createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import { getBuiltinTools, type Tool } from '../tools/registry.js';

import { resolveBuiltinAgentPackage } from './specRegistry.js';
import type { AgentCapabilityClass, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export interface AgentRuntime {
  provider: ModelProvider;
  availableTools: Tool[];
  cwd: string;
  observer: TelemetryObserver;
  resolvedPackage: ResolvedAgentPackage;
  systemPrompt: string;
  maxToolRounds: number;
}

export interface CreateAgentRuntimeOptions extends ResolvedProviderConfig {
  cwd: string;
  observer?: TelemetryObserver;
  agentSpecName?: string;
  resolvedPackage?: ResolvedAgentPackage;
}
```

And update runtime construction:

```ts
const resolvedPackage = options.resolvedPackage ?? resolveBuiltinAgentPackage(options.agentSpecName ?? 'default');

return {
  provider: createProvider({
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey
  }),
  availableTools,
  cwd: options.cwd,
  observer: options.observer ?? createNoopObserver(),
  resolvedPackage,
  systemPrompt: renderAgentSystemPrompt(resolvedPackage),
  maxToolRounds: resolvedPackage.effectivePolicy.maxToolRounds ?? 1
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/agent/runtime.test.ts`
Expected: PASS with `1 passed`

- [ ] **Step 7: Commit**

```bash
git add src/agent/spec.ts src/agent/specRegistry.ts src/agent/runtime.ts tests/agent/runtime.test.ts
git commit -m "refactor: remove structured agent spec prompt model"
```

### Task 2: Load markdown files generically and resolve prompt order from manifest

**Files:**
- Modify: `src/agent/packageLoader.ts`
- Modify: `src/agent/packageValidator.ts`
- Modify: `src/agent/packageResolver.ts`
- Test: `tests/agent/packageLoader.test.ts`
- Test: `tests/agent/packageResolver.test.ts`

- [ ] **Step 1: Write the failing loader test**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { loadAgentPackageFromDirectory } from '../../src/agent/packageLoader.js';

describe('loadAgentPackageFromDirectory', () => {
  it('loads all markdown files by filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-loader-'));
    await writeFile(join(directory, 'agent.json'), JSON.stringify({ promptFiles: ['base.md', 'style.md'] }));
    await writeFile(join(directory, 'base.md'), '# Base\n');
    await writeFile(join(directory, 'style.md'), '# Style\n');
    await writeFile(join(directory, 'notes.txt'), 'ignore me');

    const loaded = await loadAgentPackageFromDirectory(directory, { preset: 'demo', sourceTier: 'project' });

    expect(Object.keys(loaded.promptFiles).sort()).toEqual(['base.md', 'style.md']);
    expect(loaded.promptFiles['base.md']?.content).toBe('# Base\n');
    expect(loaded.promptFiles['style.md']?.content).toBe('# Style\n');
  });
});
```

- [ ] **Step 2: Write the failing resolver test**

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { resolveAgentPackage } from '../../src/agent/packageResolver.js';

describe('resolveAgentPackage', () => {
  it('appends child prompt files after parent prompt files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resolver-'));
    const builtinPackagesDirectory = join(root, 'builtin');
    await mkdir(join(builtinPackagesDirectory, 'default'), { recursive: true });
    await mkdir(join(builtinPackagesDirectory, 'readonly'), { recursive: true });

    await writeFile(
      join(builtinPackagesDirectory, 'default', 'agent.json'),
      JSON.stringify({ promptFiles: ['base.md', 'safety.md'], policy: { allowedCapabilityClasses: ['read'], maxToolRounds: 1, mutationMode: 'none' } })
    );
    await writeFile(join(builtinPackagesDirectory, 'default', 'base.md'), '# Base');
    await writeFile(join(builtinPackagesDirectory, 'default', 'safety.md'), '# Safety');

    await writeFile(
      join(builtinPackagesDirectory, 'readonly', 'agent.json'),
      JSON.stringify({ extends: 'default', promptFiles: ['repo.md'], policy: { allowedCapabilityClasses: ['read'], maxToolRounds: 1, mutationMode: 'none' } })
    );
    await writeFile(join(builtinPackagesDirectory, 'readonly', 'repo.md'), '# Repo');

    const resolved = await resolveAgentPackage('readonly', { cwd: root, builtinPackagesDirectory });

    expect(resolved.effectivePromptOrder).toEqual(['base.md', 'safety.md', 'repo.md']);
    expect(resolved.effectivePromptFiles['repo.md']?.content).toBe('# Repo');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/agent/packageLoader.test.ts tests/agent/packageResolver.test.ts`
Expected: FAIL because loader still filters fixed slot names and resolver still merges prompt files as slot overrides.

- [ ] **Step 4: Refactor `src/agent/packageLoader.ts` to load every `.md` file**

Replace the loader loop with this implementation:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateManifestShape } from './packageValidator.js';
import type { AgentPackageSourceTier, AgentPromptFile, LoadedAgentPackage } from './spec.js';

export async function loadAgentPackageFromDirectory(
  directoryPath: string,
  options: { preset: string; sourceTier: AgentPackageSourceTier }
): Promise<LoadedAgentPackage> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const promptFiles: Record<string, AgentPromptFile> = {};
  let manifest: LoadedAgentPackage['manifest'];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === 'agent.json') {
      const manifestPath = join(directoryPath, entry.name);
      const raw = await readFile(manifestPath, 'utf8');
      const parsedManifest = JSON.parse(normalizeLineEndings(raw)) as LoadedAgentPackage['manifest'];
      const manifestErrors = validateManifestShape(options.preset, parsedManifest);

      if (manifestErrors.length > 0) {
        throw new Error(`Agent package "${options.preset}" has invalid manifest in ${manifestPath}.\n${manifestErrors.join('\n')}`);
      }

      manifest = parsedManifest;
      continue;
    }

    if (!entry.name.endsWith('.md')) {
      continue;
    }

    const filePath = join(directoryPath, entry.name);
    const raw = await readFile(filePath, 'utf8');
    promptFiles[entry.name] = {
      filePath,
      content: normalizeLineEndings(raw)
    };
  }

  return {
    preset: options.preset,
    sourceTier: options.sourceTier,
    directoryPath,
    manifestPath: join(directoryPath, 'agent.json'),
    manifest,
    promptFiles
  };
}
```

- [ ] **Step 5: Update `src/agent/packageValidator.ts` for `promptFiles: string[]`**

Add manifest validation:

```ts
if (manifest.promptFiles !== undefined) {
  if (!Array.isArray(manifest.promptFiles)) {
    errors.push(`Agent package "${preset}" must set promptFiles to an array when provided.`);
  } else {
    for (const fileName of manifest.promptFiles) {
      if (typeof fileName !== 'string' || fileName.trim().length === 0) {
        errors.push(`Agent package "${preset}" must declare promptFiles entries as non-empty strings.`);
      }
    }
  }
}
```

Replace the base-package checks with:

```ts
if (!agentPackage.manifest.extends && (agentPackage.manifest.promptFiles?.length ?? 0) === 0) {
  errors.push(`Base package "${agentPackage.preset}" must provide at least one prompt file in agent.json.`);
}

for (const fileName of agentPackage.manifest.promptFiles ?? []) {
  if (!agentPackage.promptFiles[fileName]) {
    errors.push(`Agent package "${agentPackage.preset}" references missing prompt file "${fileName}".`);
  }
}
```

And add resolved validation:

```ts
if (agentPackage.effectivePromptOrder.length === 0) {
  errors.push(`Agent package "${agentPackage.preset}" must resolve at least one prompt file.`);
}

for (const fileName of agentPackage.effectivePromptOrder) {
  if (!agentPackage.effectivePromptFiles[fileName]) {
    errors.push(`Agent package "${agentPackage.preset}" resolved missing prompt file "${fileName}".`);
  }
}
```

- [ ] **Step 6: Refactor `src/agent/packageResolver.ts` to merge prompt order parent-first**

Use this structure in `resolveAgentPackage`:

```ts
const packageChain = await loadResolvedChain(preset, options, visited, stack, preset);
const chainInInheritanceOrder = [...packageChain].reverse();
const effectivePolicy = mergePolicyChain(packageChain);
const effectiveCompletion = mergeCompletionChain(packageChain);
const effectiveDiagnostics = mergeDiagnosticsChain(packageChain);
const effectivePromptFiles = mergePromptFileMap(chainInInheritanceOrder);
const effectivePromptOrder = mergePromptOrder(chainInInheritanceOrder);
const resolvedFiles = [
  ...new Set(
    chainInInheritanceOrder.flatMap((agentPackage) => [
      agentPackage.manifestPath,
      ...(agentPackage.manifest?.promptFiles ?? []).flatMap((fileName) => {
        const promptFile = agentPackage.promptFiles[fileName];
        return promptFile ? [promptFile.filePath] : [];
      })
    ])
  )
];
```

Add the merge helpers:

```ts
function mergePromptFileMap(packageChain: LoadedAgentPackage[]) {
  return packageChain.reduce<ResolvedAgentPackage['effectivePromptFiles']>((merged, agentPackage) => ({
    ...merged,
    ...agentPackage.promptFiles
  }), {});
}

function mergePromptOrder(packageChain: LoadedAgentPackage[]) {
  return packageChain.flatMap((agentPackage) => agentPackage.manifest?.promptFiles ?? []);
}
```

Keep `loadResolvedChain` returning `[loaded, ...parentChain]`, but reverse once at the top so merge order becomes parent then child.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/agent/packageLoader.test.ts tests/agent/packageResolver.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 8: Commit**

```bash
git add src/agent/packageLoader.ts src/agent/packageValidator.ts src/agent/packageResolver.ts tests/agent/packageLoader.test.ts tests/agent/packageResolver.test.ts
git commit -m "refactor: resolve agent prompts from manifest order"
```

### Task 3: Render prompt and previews from resolved filename order

**Files:**
- Modify: `src/agent/specPrompt.ts`
- Modify: `src/agent/packagePreview.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/agent/specPrompt.test.ts`

- [ ] **Step 1: Write the failing prompt-render test**

```ts
import { describe, expect, it } from 'vitest';

import { renderAgentSystemPrompt } from '../../src/agent/specPrompt.js';

describe('renderAgentSystemPrompt', () => {
  it('renders prompt files in effective prompt order', () => {
    const rendered = renderAgentSystemPrompt({
      preset: 'demo',
      sourceTier: 'builtin',
      extendsChain: ['demo'],
      packageChain: [],
      effectivePolicy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 1,
        mutationMode: 'none'
      },
      effectiveCompletion: undefined,
      effectiveDiagnostics: undefined,
      effectivePromptFiles: {
        'base.md': { filePath: '/tmp/base.md', content: '# Base' },
        'repo.md': { filePath: '/tmp/repo.md', content: '# Repo' }
      },
      effectivePromptOrder: ['base.md', 'repo.md'],
      resolvedFiles: ['/tmp/base.md', '/tmp/repo.md']
    });

    expect(rendered).toContain('# Base\n\n# Repo');
    expect(rendered).toContain('Runtime constraints summary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/specPrompt.test.ts`
Expected: FAIL because renderer still iterates fixed slot names.

- [ ] **Step 3: Update `src/agent/specPrompt.ts` to render by `effectivePromptOrder`**

Replace the slot-order logic with:

```ts
import type { ResolvedAgentPackage } from './spec.js';

export function renderAgentSystemPrompt(resolvedPackage: ResolvedAgentPackage): string {
  const sections = resolvedPackage.effectivePromptOrder
    .map((fileName) => resolvedPackage.effectivePromptFiles[fileName]?.content)
    .filter((content): content is string => typeof content === 'string')
    .concat(renderRuntimeConstraintsSummary(resolvedPackage));

  return sections.join('\n\n');
}
```

Keep `renderRuntimeConstraintsSummary` unchanged.

- [ ] **Step 4: Update `src/agent/packagePreview.ts` to expose ordered prompt files**

Replace the preview builder with:

```ts
import type { AgentPackagePreview, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export function createAgentPackagePreview(agentPackage: ResolvedAgentPackage): AgentPackagePreview {
  return {
    preset: agentPackage.preset,
    sourceTier: agentPackage.sourceTier,
    extendsChain: agentPackage.extendsChain,
    promptFiles: agentPackage.effectivePromptOrder.flatMap((fileName) => {
      const promptFile = agentPackage.effectivePromptFiles[fileName];
      return promptFile ? [{ fileName, filePath: promptFile.filePath }] : [];
    }),
    resolvedFiles: agentPackage.resolvedFiles,
    effectiveRuntimePolicy: agentPackage.effectivePolicy,
    renderedPromptText: renderAgentSystemPrompt(agentPackage)
  };
}
```

- [ ] **Step 5: Update CLI preview formatting in `src/cli/main.ts`**

Replace the `sectionFileLines` block inside `formatAgentSpecPreview` with:

```ts
const promptFileLines = preview.promptFiles
  .map((entry) => `- ${entry.fileName}: ${entry.filePath}`)
  .join('\n');
const effectivePolicyText = JSON.stringify(preview.effectiveRuntimePolicy, null, 2);

return [
  `Agent spec preview: ${preview.preset}`,
  `Source tier: ${preview.sourceTier}`,
  `Inheritance chain: ${preview.extendsChain.join(' -> ')}`,
  'Prompt files:',
  promptFileLines || '- (none)',
  'Effective runtime policy:',
  effectivePolicyText,
  'Rendered system prompt:',
  preview.renderedPromptText,
  ''
].join('\n');
```

Also remove the import/use of `agentPromptSlotFileNames` if it becomes unused.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/agent/specPrompt.test.ts`
Expected: PASS with `1 passed`

- [ ] **Step 7: Commit**

```bash
git add src/agent/specPrompt.ts src/agent/packagePreview.ts src/cli/main.ts tests/agent/specPrompt.test.ts
git commit -m "refactor: render agent prompt from ordered markdown files"
```

### Task 4: Remove remaining `AgentSpec` fallbacks and migrate builtin packages

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/builtin-packages/default/agent.json`
- Modify: `src/agent/builtin-packages/readonly/agent.json`
- Test: `tests/agent/runtime.test.ts`
- Test: `tests/agent/packageResolver.test.ts`

- [ ] **Step 1: Write the failing loop/runtime regression test**

Append this case to `tests/agent/runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createRunAgentTurnExecution } from '../../src/agent/loop.js';

describe('createRunAgentTurnExecution', () => {
  it('reads include flags and completion metadata from resolvedPackage only', async () => {
    const execution = createRunAgentTurnExecution({
      provider: {
        async generate(messages) {
          return {
            provider: 'test',
            model: 'fake',
            message: { role: 'assistant', content: 'done' },
            stopReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 }
          };
        }
      },
      availableTools: [],
      baseSystemPrompt: 'Base prompt',
      userInput: 'Say hello',
      cwd: '/tmp/project',
      maxToolRounds: 1,
      resolvedPackage: {
        preset: 'demo',
        sourceTier: 'builtin',
        extendsChain: ['demo'],
        packageChain: [],
        effectivePolicy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 1,
          mutationMode: 'none',
          includeMemory: false,
          includeSkills: false,
          includeHistorySummary: false
        },
        effectiveCompletion: {
          completionMode: 'single-turn',
          doneCriteriaShape: 'substantive answer',
          evidenceRequirement: 'direct evidence',
          stopVsDoneDistinction: 'stop is not done'
        },
        effectiveDiagnostics: undefined,
        effectivePromptFiles: {
          'base.md': { filePath: '/tmp/base.md', content: '# Base' }
        },
        effectivePromptOrder: ['base.md'],
        resolvedFiles: ['/tmp/base.md']
      }
    });

    const result = await execution.turnResult;
    expect(result.doneCriteria.maxToolRounds).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent/runtime.test.ts tests/agent/packageResolver.test.ts`
Expected: FAIL because `loop.ts` still references `input.agentSpec` fallbacks and builtin manifests still do not declare `promptFiles`.

- [ ] **Step 3: Remove `agentSpec` fallbacks from `src/agent/loop.ts`**

Update the input type and completion/context resolution.

Replace the input interface fields:

```ts
export interface RunAgentTurnInput {
  provider: ModelProvider;
  availableTools: Tool[];
  baseSystemPrompt: string;
  userInput: string;
  cwd: string;
  maxToolRounds: number;
  resolvedPackage?: ResolvedAgentPackage;
  observer?: TelemetryObserver;
  memoryText?: string;
  skillsText?: string;
  historySummary?: string;
  history?: Message[];
}
```

Replace `resolveTurnCompletionSpec` with:

```ts
function resolveTurnCompletionSpec(input: RunAgentTurnInput): AgentCompletionSpec | undefined {
  if (!input.resolvedPackage) {
    return undefined;
  }

  const policy = input.resolvedPackage.effectivePolicy;
  const completion = input.resolvedPackage.effectiveCompletion;
  return {
    completionMode: completion?.completionMode ?? 'runtime-policy',
    doneCriteriaShape: completion?.doneCriteriaShape ?? 'runtime-policy',
    evidenceRequirement: completion?.evidenceRequirement ?? 'runtime-policy',
    stopVsDoneDistinction: completion?.stopVsDoneDistinction ?? 'runtime-policy',
    maxToolRounds: policy.maxToolRounds ?? input.maxToolRounds,
    requiresToolEvidence: policy.requiresToolEvidence,
    requiresSubstantiveFinalAnswer: policy.requiresSubstantiveFinalAnswer,
    forbidSuccessAfterToolErrors: policy.forbidSuccessAfterToolErrors
  };
}
```

And replace prompt context assembly flags with:

```ts
const prompt = buildPromptWithContext({
  baseSystemPrompt: input.baseSystemPrompt,
  memoryText: input.memoryText,
  skillsText: input.skillsText,
  historySummary: input.historySummary,
  includeMemory: resolvedPolicy?.includeMemory,
  includeSkills: resolvedPolicy?.includeSkills,
  includeHistorySummary: resolvedPolicy?.includeHistorySummary,
  history
});
```

- [ ] **Step 4: Add `promptFiles` to builtin manifests**

Update `src/agent/builtin-packages/default/agent.json` to:

```json
{
  "promptFiles": ["AGENT.md", "SOUL.md", "STYLE.md", "TOOLS.md", "USER.md"],
  "policy": {
    "allowedCapabilityClasses": ["read", "write", "search", "exec_readonly", "execute"],
    "maxToolRounds": 10,
    "requiresSubstantiveFinalAnswer": true,
    "forbidSuccessAfterToolErrors": true,
    "mutationMode": "workspace-write",
    "includeMemory": true,
    "includeSkills": true,
    "includeHistorySummary": true,
    "diagnosticsParticipationLevel": "normal",
    "redactionSensitivity": "standard"
  },
  "completion": {
    "completionMode": "Single-turn task completion with evidence-aware verification.",
    "doneCriteriaShape": "Return a non-empty final answer and provide tool evidence when the task requires inspection.",
    "evidenceRequirement": "Use direct project evidence for inspection-style claims.",
    "stopVsDoneDistinction": "A provider stop is not enough unless the final answer satisfies verification criteria."
  },
  "diagnostics": {
    "traceabilityExpectation": "Keep runtime telemetry traceable without exposing unnecessary host details."
  }
}
```

Update `src/agent/builtin-packages/readonly/agent.json` to:

```json
{
  "extends": "default",
  "promptFiles": ["AGENT.md", "SOUL.md", "STYLE.md", "TOOLS.md", "USER.md"],
  "policy": {
    "allowedCapabilityClasses": ["read", "search", "exec_readonly"],
    "maxToolRounds": 6,
    "requiresToolEvidence": true,
    "requiresSubstantiveFinalAnswer": true,
    "forbidSuccessAfterToolErrors": true,
    "mutationMode": "none",
    "includeMemory": true,
    "includeSkills": true,
    "includeHistorySummary": true,
    "diagnosticsParticipationLevel": "normal",
    "redactionSensitivity": "standard"
  },
  "completion": {
    "completionMode": "Single-turn read-only inspection with strict evidence-aware verification.",
    "doneCriteriaShape": "Return a substantive final answer grounded in direct project inspection evidence.",
    "evidenceRequirement": "Use successful read/search tool results for inspection-style claims.",
    "stopVsDoneDistinction": "A provider stop is insufficient unless the answer is substantive and consistent with the observed tool results."
  },
  "diagnostics": {
    "traceabilityExpectation": "Keep inspection evidence and verifier outcomes traceable."
  }
}
```

- [ ] **Step 5: Run targeted tests and build**

Run: `npm test -- tests/agent/runtime.test.ts tests/agent/packageLoader.test.ts tests/agent/packageResolver.test.ts tests/agent/specPrompt.test.ts && npm run build`
Expected: PASS with all targeted tests green, then successful TypeScript build.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts src/agent/builtin-packages/default/agent.json src/agent/builtin-packages/readonly/agent.json tests/agent/runtime.test.ts tests/agent/packageLoader.test.ts tests/agent/packageResolver.test.ts tests/agent/specPrompt.test.ts
git commit -m "refactor: migrate agent packages to manifest prompt assembly"
```

## Self-Review

### Spec coverage
- `promptFiles: string[]` manifest model — covered in Task 1 Step 3 and Task 2 Step 5
- load all `.md` files by filename — covered in Task 2 Step 4
- parent-first append-child prompt merge — covered in Task 2 Step 6
- remove `AgentSpec` structured extraction — covered in Task 1 Steps 3-5 and Task 4 Step 3
- render ordered prompt text — covered in Task 3 Steps 3-5
- migrate preview/runtime consumers — covered in Task 1 Step 5, Task 3 Steps 4-5, Task 4 Step 3
- migrate builtin packages — covered in Task 4 Step 4
- verify with tests/build — covered in Tasks 1-4 test steps and Task 4 Step 5

### Placeholder scan
- No `TODO`, `TBD`, or deferred implementation placeholders remain.
- Every code-changing step includes concrete code or exact JSON content.
- Every test step includes exact commands and expected outcomes.

### Type consistency
- Prompt file names consistently use `string`/`AgentPromptFileName`.
- Resolved prompt order consistently uses `effectivePromptOrder`.
- Runtime and loop consistently depend on `ResolvedAgentPackage`, not `AgentSpec`.
