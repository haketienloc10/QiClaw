# QICLAW Shared Prompt File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-package `QICLAW.md` copies with one shared file at `src/agent/shared/QICLAW.md` that is injected into every resolved agent prompt and always rendered first when present.

**Architecture:** Add one shared prompt-file path helper, load the shared file into resolved prompt state for builtin and package-chain resolution, and keep `specPrompt.ts` render-only. Validation continues to enforce that `QICLAW.md` must be first whenever it exists, while build asset copying is extended so the shared file is available from `dist/` too.

**Tech Stack:** TypeScript, Node.js fs/fs/promises, Vitest, existing QiClaw agent package resolution modules

---

## File Structure

**Create:**
- `src/agent/shared/QICLAW.md` — single source of truth for the shared QiClaw prompt section

**Modify:**
- `src/agent/packagePaths.ts` — add helper for the shared prompt file path
- `src/agent/specRegistry.ts` — load shared prompt file into builtin resolved prompt state and stop requiring package-local `QICLAW.md`
- `src/agent/packageResolver.ts` — merge shared prompt file into project/user/builtin resolved prompt state
- `src/agent/packageValidator.ts` — keep the resolved-order invariant for `QICLAW.md`
- `scripts/copy-agent-assets.mjs` — copy `src/agent/shared` to `dist/agent/shared`
- `src/agent/builtin-packages/default/agent.json` — remove `QICLAW.md` from `promptFiles` if present
- `src/agent/builtin-packages/readonly/agent.json` — remove `QICLAW.md` from `promptFiles` if present
- `tests/agent/specRegistry.test.ts` — assert builtin resolution uses the shared file and no longer depends on package-local copies
- `tests/agent/packageResolver.test.ts` — assert package-chain resolution uses the shared file and keeps other order semantics
- `tests/agent/specPrompt.test.ts` — keep render-order coverage with `QICLAW.md` first

**Delete:**
- `src/agent/builtin-packages/default/QICLAW.md`
- `src/agent/builtin-packages/readonly/QICLAW.md`

---

### Task 1: Move QICLAW content to one shared file and remove builtin copies

**Files:**
- Create: `src/agent/shared/QICLAW.md`
- Modify: `src/agent/builtin-packages/default/agent.json:1-24`
- Modify: `src/agent/builtin-packages/readonly/agent.json:1-26`
- Delete: `src/agent/builtin-packages/default/QICLAW.md`
- Delete: `src/agent/builtin-packages/readonly/QICLAW.md`
- Test: `tests/agent/specRegistry.test.ts`

- [ ] **Step 1: Write the failing builtin-resolution test for a shared QICLAW file**

```ts
it('loads QICLAW.md from the shared agent directory for builtin packages', async () => {
  const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
  const sharedDirectory = join(builtinPackagesDirectory, '..', 'shared');
  await mkdir(sharedDirectory, { recursive: true });
  await writeFile(join(sharedDirectory, 'QICLAW.md'), '# QICLAW.md\n\nShared qiclaw instructions\n');

  await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
    manifest: {
      promptFiles: ['AGENT.md', 'USER.md'],
      policy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 2,
        mutationMode: 'none'
      }
    },
    promptFiles: {
      'AGENT.md': 'Purpose: Default\nScope boundary: Default',
      'USER.md': 'Default user instructions'
    }
  });

  const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory);
  const resolved = resolveBuiltinAgentPackage('default');

  expect(resolved.effectivePromptOrder[0]).toBe('QICLAW.md');
  expect(resolved.effectivePromptFiles['QICLAW.md']?.content).toContain('Shared qiclaw instructions');
  expect(resolved.effectivePromptFiles['QICLAW.md']?.filePath).toBe(join(sharedDirectory, 'QICLAW.md'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/specRegistry.test.ts`
Expected: FAIL because builtin resolution still expects package-local `QICLAW.md` behavior or cannot see the shared file.

- [ ] **Step 3: Create the shared prompt file**

Create `src/agent/shared/QICLAW.md` with this content:

```md
# QICLAW.md

Hãy ưu tiên các quy tắc và dữ kiện đặc thù của QiClaw trước các hướng dẫn prompt chung khác khi chúng cùng áp dụng.
```

- [ ] **Step 4: Remove QICLAW.md from builtin manifests**

Update `src/agent/builtin-packages/default/agent.json` to this prompt file list:

```json
{
  "promptFiles": ["AGENT.md", "SOUL.md", "STYLE.md", "TOOLS.md", "USER.md"],
  "policy": {
    "allowedCapabilityClasses": ["read", "write"],
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

Update `src/agent/builtin-packages/readonly/agent.json` to this prompt file list:

```json
{
  "extends": "default",
  "promptFiles": ["AGENT.md", "SOUL.md", "STYLE.md", "TOOLS.md", "USER.md"],
  "policy": {
    "allowedCapabilityClasses": ["read"],
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
    "evidenceRequirement": "Use successful tool results for inspection-style claims.",
    "stopVsDoneDistinction": "A provider stop is insufficient unless the answer is substantive and consistent with the observed tool results."
  },
  "diagnostics": {
    "traceabilityExpectation": "Keep inspection evidence and verifier outcomes traceable."
  }
}
```

- [ ] **Step 5: Delete the old builtin copies**

Run:

```bash
rm src/agent/builtin-packages/default/QICLAW.md src/agent/builtin-packages/readonly/QICLAW.md
```

Expected: both package-local copies are removed so `src/agent/shared/QICLAW.md` is the only remaining source.

- [ ] **Step 6: Run the builtin-resolution test to confirm it still fails for resolver code only**

Run: `npm test -- tests/agent/specRegistry.test.ts`
Expected: FAIL because the shared file exists but resolver/path logic still does not load it.

- [ ] **Step 7: Commit the shared-file migration prep**

```bash
git add src/agent/shared/QICLAW.md src/agent/builtin-packages/default/agent.json src/agent/builtin-packages/readonly/agent.json src/agent/builtin-packages/default/QICLAW.md src/agent/builtin-packages/readonly/QICLAW.md tests/agent/specRegistry.test.ts
git commit -m "refactor: move qiclaw prompt to shared source"
```

### Task 2: Load the shared QICLAW file into builtin resolution

**Files:**
- Modify: `src/agent/packagePaths.ts:1-26`
- Modify: `src/agent/specRegistry.ts:1-176`
- Test: `tests/agent/specRegistry.test.ts`

- [ ] **Step 1: Add a failing test for shared-file path resolution in builtin registry fixtures**

Add this test to `tests/agent/specRegistry.test.ts`:

```ts
it('keeps builtin manifest order for other files after prepending shared QICLAW.md', async () => {
  const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
  const sharedDirectory = join(builtinPackagesDirectory, '..', 'shared');
  await mkdir(sharedDirectory, { recursive: true });
  await writeFile(join(sharedDirectory, 'QICLAW.md'), '# QICLAW.md\n\nShared qiclaw instructions\n');

  await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
    manifest: {
      promptFiles: ['USER.md', 'AGENT.md'],
      policy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 2,
        mutationMode: 'none'
      }
    },
    promptFiles: {
      'AGENT.md': 'Purpose: Default\nScope boundary: Default',
      'USER.md': 'Default user instructions'
    }
  });

  const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory);
  const resolved = resolveBuiltinAgentPackage('default');

  expect(resolved.effectivePromptOrder).toEqual(['QICLAW.md', 'USER.md', 'AGENT.md']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/specRegistry.test.ts`
Expected: FAIL because builtin registry still does not merge a shared prompt file into `effectivePromptFiles`.

- [ ] **Step 3: Add a shared-path helper in `src/agent/packagePaths.ts`**

Append this export after `getBuiltinAgentPackageDirectory(...)`:

```ts
export function getSharedAgentPromptFilePath(fileName: string, agentRootDirectory: string = agentDirectoryPath): string {
  return join(agentRootDirectory, 'shared', fileName);
}
```

- [ ] **Step 4: Update builtin registry to read the shared file and merge it**

In `src/agent/specRegistry.ts` make these exact changes:

1. Update imports:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getBuiltinAgentPackageDirectory, getSharedAgentPromptFilePath } from './packagePaths.js';
```

2. Replace the default order constant section with:

```ts
const builtinPackagesDirectory = dirname(getBuiltinAgentPackageDirectory('default'));
const builtinAgentPackageNames = readdirSync(builtinPackagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort() as BuiltinAgentPackageName[];
const priorityPromptFileName = 'QICLAW.md';
const defaultPromptOrder: AgentPromptFileName[] = ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md'];
```

3. Add this helper near `loadBuiltinPackage(...)`:

```ts
function loadSharedPromptFile(): Record<AgentPromptFileName, ResolvedAgentPackage['effectivePromptFiles'][AgentPromptFileName]> {
  const filePath = getSharedAgentPromptFilePath(priorityPromptFileName);

  if (!existsSync(filePath)) {
    return {};
  }

  return {
    [priorityPromptFileName]: {
      filePath,
      content: normalizeLineEndings(readFileSync(filePath, 'utf8'))
    }
  };
}
```

4. Change resolved prompt-file assembly to:

```ts
  const effectivePromptFiles = {
    ...(parentPackage?.effectivePromptFiles ?? {}),
    ...loaded.promptFiles,
    ...loadSharedPromptFile()
  };
```

5. Keep `prioritizePromptFile(...)` but make it prepend only when `effectivePromptFiles['QICLAW.md']` exists.

- [ ] **Step 5: Run builtin registry tests to verify they pass**

Run: `npm test -- tests/agent/specRegistry.test.ts`
Expected: PASS, including shared-file path assertions and preserved order for other manifest entries.

- [ ] **Step 6: Commit builtin shared-file loading**

```bash
git add src/agent/packagePaths.ts src/agent/specRegistry.ts tests/agent/specRegistry.test.ts
git commit -m "feat: load shared qiclaw prompt for builtin specs"
```

### Task 3: Load the shared QICLAW file into package-chain resolution and keep validator invariant

**Files:**
- Modify: `src/agent/packageResolver.ts:1-207`
- Modify: `src/agent/packageValidator.ts:83-120`
- Test: `tests/agent/packageResolver.test.ts`

- [ ] **Step 1: Write the failing package-chain test for shared QICLAW.md**

Add this test to `tests/agent/packageResolver.test.ts`:

```ts
it('loads QICLAW.md from the shared agent directory for package-chain resolution', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
  tempDirs.push(tempDir);

  const cwd = join(tempDir, 'workspace');
  const builtinPackagesDirectory = join(tempDir, 'builtin-packages');
  const agentRootDirectory = join(tempDir, 'agent-root');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(agentRootDirectory, 'shared'), { recursive: true });
  await writeFile(join(agentRootDirectory, 'shared', 'QICLAW.md'), '# QICLAW.md\n\nShared qiclaw instructions\n');

  await writePackageFixture(join(builtinPackagesDirectory, 'base'), {
    manifest: {
      promptFiles: ['SOUL.md', 'AGENT.md']
    },
    sections: {
      'AGENT.md': 'Base agent\n',
      'SOUL.md': 'Base soul\n'
    }
  });

  const resolved = await resolveAgentPackage('base', {
    cwd,
    homeDirectory: join(tempDir, 'home'),
    builtinPackagesDirectory
  });

  expect(resolved.effectivePromptOrder).toEqual(['QICLAW.md', 'SOUL.md', 'AGENT.md']);
  expect(resolved.effectivePromptFiles['QICLAW.md']?.content).toContain('Shared qiclaw instructions');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/packageResolver.test.ts`
Expected: FAIL because `resolveAgentPackage()` still only merges prompt files from package directories.

- [ ] **Step 3: Update package-chain resolver to merge the shared file**

In `src/agent/packageResolver.ts` make these exact changes:

1. Update imports:

```ts
import { constants, existsSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';

import {
  getBuiltinAgentPackageDirectory,
  getProjectAgentPackageDirectory,
  getSharedAgentPromptFilePath,
  getUserAgentPackageDirectory
} from './packagePaths.js';
```

2. Add this helper above `resolveAgentPackage(...)`:

```ts
function loadSharedPromptFile(): ResolvedAgentPackage['effectivePromptFiles'] {
  const filePath = getSharedAgentPromptFilePath(priorityPromptFileName);

  if (!existsSync(filePath)) {
    return {};
  }

  return {
    [priorityPromptFileName]: {
      filePath,
      content: readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n')
    }
  };
}
```

3. Change resolved prompt-file assembly to:

```ts
  const effectivePromptFiles = {
    ...mergePromptFileChain(packageChain),
    ...loadSharedPromptFile()
  };
```

4. Keep `prioritizePromptFile(...)` as the single place that prepends `QICLAW.md` when it exists.

- [ ] **Step 4: Keep validator invariant and add explicit failure coverage**

Ensure `src/agent/packageValidator.ts` still contains this exact guard in `validateResolvedAgentPackage(...)`:

```ts
  if (
    agentPackage.effectivePromptFiles[priorityPromptFileName] &&
    agentPackage.effectivePromptOrder[0] !== priorityPromptFileName
  ) {
    errors.push(`Agent package "${agentPackage.preset}" must place "${priorityPromptFileName}" first in resolved prompt order when present.`);
  }
```

And keep a test like this in `tests/agent/packageResolver.test.ts`:

```ts
expect(
  validateResolvedAgentPackage({
    preset: 'reviewer',
    sourceTier: 'project',
    extendsChain: ['reviewer'],
    packageChain: [],
    effectivePolicy: {},
    effectiveCompletion: undefined,
    effectiveDiagnostics: undefined,
    effectivePromptOrder: ['AGENT.md', 'QICLAW.md'],
    effectivePromptFiles: {
      'AGENT.md': { filePath: '/tmp/AGENT.md', content: 'agent\n' },
      'QICLAW.md': { filePath: '/tmp/QICLAW.md', content: 'qiclaw\n' }
    },
    resolvedFiles: []
  })
).toContain('Agent package "reviewer" must place "QICLAW.md" first in resolved prompt order when present.');
```

- [ ] **Step 5: Run package resolver tests to verify they pass**

Run: `npm test -- tests/agent/packageResolver.test.ts`
Expected: PASS, including shared-file loading and validator invariant coverage.

- [ ] **Step 6: Commit package-chain shared-file loading**

```bash
git add src/agent/packageResolver.ts src/agent/packageValidator.ts tests/agent/packageResolver.test.ts
git commit -m "feat: apply shared qiclaw prompt to resolved packages"
```

### Task 4: Keep render/build behavior aligned with the shared prompt file

**Files:**
- Modify: `scripts/copy-agent-assets.mjs:1-22`
- Modify: `tests/agent/specPrompt.test.ts:1-74`
- Test: `tests/agent/specPrompt.test.ts`
- Test: `tests/agent/specRegistry.test.ts`
- Test: `tests/agent/packageResolver.test.ts`

- [ ] **Step 1: Write the failing build-asset expectation and render-order assertion**

Update `tests/agent/specPrompt.test.ts` to keep this explicit render case:

```ts
it('renders QICLAW.md before every other prompt section when it is first in effective prompt order', () => {
  const rendered = renderAgentSystemPrompt({
    ...resolvedPackage,
    effectivePromptFiles: {
      'QICLAW.md': {
        filePath: '/tmp/QICLAW.md',
        content: '# QICLAW'
      },
      ...resolvedPackage.effectivePromptFiles
    },
    effectivePromptOrder: ['QICLAW.md', 'base.md', 'repo.md'],
    resolvedFiles: ['/tmp/QICLAW.md', '/tmp/base.md', '/tmp/repo.md']
  });

  expect(rendered).toContain('# QICLAW\n\n# Base\n\n# Repo');
});
```

And add this source/dist asset assertion to `tests/agent/specRegistry.test.ts` inside `loads builtin assets from source and dist without CHECKLIST.md leftovers`:

```ts
      await expect(readFile(join(projectRoot, 'src', 'agent', 'shared', 'QICLAW.md'), 'utf8')).resolves.toContain('# QICLAW.md');
      if (existsSync(join(projectRoot, 'dist', 'agent', 'shared'))) {
        await expect(readFile(join(projectRoot, 'dist', 'agent', 'shared', 'QICLAW.md'), 'utf8')).resolves.toContain('# QICLAW.md');
      }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent/specPrompt.test.ts tests/agent/specRegistry.test.ts`
Expected: FAIL because `dist/agent/shared/QICLAW.md` is not copied yet.

- [ ] **Step 3: Update the asset copy script**

Change `scripts/copy-agent-assets.mjs` from:

```js
copyDirectory(
  join(projectRootPath, 'src', 'agent', 'builtin-packages'),
  join(projectRootPath, 'dist', 'agent', 'builtin-packages')
);

copyDirectory(
  join(projectRootPath, 'src/tools/python'),
  join(projectRootPath, 'dist/tools/python')
);
```

to:

```js
copyDirectory(
  join(projectRootPath, 'src', 'agent', 'builtin-packages'),
  join(projectRootPath, 'dist', 'agent', 'builtin-packages')
);

copyDirectory(
  join(projectRootPath, 'src', 'agent', 'shared'),
  join(projectRootPath, 'dist', 'agent', 'shared')
);

copyDirectory(
  join(projectRootPath, 'src/tools/python'),
  join(projectRootPath, 'dist/tools/python')
);
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm test -- tests/agent/specPrompt.test.ts tests/agent/specRegistry.test.ts`
Expected: PASS, with render order still correct and source/dist shared-file assets present.

- [ ] **Step 5: Run the full targeted verification suite**

Run: `npm test -- tests/agent/specRegistry.test.ts tests/agent/packageResolver.test.ts tests/agent/specPrompt.test.ts && npm run build`
Expected: PASS with all targeted tests green and build copying `dist/agent/shared/QICLAW.md` successfully.

- [ ] **Step 6: Commit render/build alignment**

```bash
git add scripts/copy-agent-assets.mjs tests/agent/specPrompt.test.ts tests/agent/specRegistry.test.ts
git commit -m "build: package shared qiclaw prompt asset"
```

---

## Self-Review

### Spec coverage
- Shared file path helper: covered in Task 2.
- Builtin resolver merges shared file: covered in Task 2.
- Package-chain resolver merges shared file: covered in Task 3.
- Validator invariant remains enforced: covered in Task 3.
- Build asset copy for `dist/agent/shared`: covered in Task 4.
- Removal of package-local builtin copies and manifest entries: covered in Task 1.
- Render behavior unchanged except for resolved order: covered in Task 4.

No uncovered spec requirements remain.

### Placeholder scan
- No `TODO`, `TBD`, or “similar to” steps remain.
- Every code-changing step contains exact code or exact command content.
- Every verification step names the exact command and expected result.

### Type consistency
- The plan consistently uses `priorityPromptFileName = 'QICLAW.md'`.
- Shared prompt state is always described as `effectivePromptFiles['QICLAW.md']` plus `effectivePromptOrder[0]`.
- Path helper naming is consistent as `getSharedAgentPromptFilePath(...)`.
