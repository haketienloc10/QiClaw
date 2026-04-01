# CLI Env Autoload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the QiClaw CLI automatically load `.env` and `.env.local` from the current working directory before provider config resolution, with `.env.local` overriding `.env`, shell environment winning over both, and CLI flags staying highest precedence.

**Architecture:** Keep env-file loading at the CLI boundary in [src/cli/main.ts](src/cli/main.ts) so provider modules remain unchanged and continue reading resolved config or `process.env`. Add a tiny parser/loader for simple `KEY=value` files, then verify end-to-end behavior through CLI tests that exercise temp directories and real env files.

**Tech Stack:** TypeScript, Node.js `fs`, Vitest, existing CLI/provider config helpers.

---

## File map

- Modify: [src/cli/main.ts](src/cli/main.ts) — add env-file loader and invoke it before arg parsing.
- Modify: [tests/cli/repl.test.ts](tests/cli/repl.test.ts) — add TDD coverage for `.env`, `.env.local`, shell env precedence, and CLI flag precedence.
- Modify: [.gitignore](.gitignore) — ignore `.env.local`.

## Notes before implementation

- The current provider defaults in [src/provider/config.ts](src/provider/config.ts) are user-edited and must be preserved as-is.
- Do not add `dotenv` or any new dependency.
- Keep parser intentionally narrow: support simple `KEY=value`, blank lines, and `#` comments only.
- Do not change provider modules for this feature.

### Task 1: Add failing tests for CLI env-file autoload

**Files:**
- Modify: `tests/cli/repl.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing test for loading values from `.env`**

```ts
  it('loads provider config from a cwd .env file before creating the runtime', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-'));
    tempDirs.push(tempDir);

    await writeFile(join(tempDir, '.env'), [
      'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
      'OPENAI_API_KEY=openai-dotenv-key'
    ].join('\n'), 'utf8');

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => {
        expect(runtimeOptions).toMatchObject({
          provider: 'openai',
          model: 'gpt-5.4',
          baseUrl: 'https://openai-from-dotenv.example/v1',
          apiKey: 'openai-dotenv-key',
          cwd: tempDir
        });

        return {
          provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: runtimeOptions.cwd,
          observer: runtimeOptions.observer ?? { record() {} }
        };
      },
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `handled: ${input.userInput}`,
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          toolEvidenceSatisfied: true,
          toolMessagesCount: 0,
          checks: []
        }
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(writes).toEqual(['handled: inspect package.json\n']);
  });
```

- [ ] **Step 2: Run the targeted test to verify it fails for the right reason**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts
```

Expected: FAIL because the runtime options still have `baseUrl` and `apiKey` as `undefined` when only `.env` is present.

- [ ] **Step 3: Write the failing test for `.env.local` overriding `.env`**

```ts
  it('prefers .env.local values over .env values from the same cwd', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-local-'));
    tempDirs.push(tempDir);

    await writeFile(join(tempDir, '.env'), [
      'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
      'OPENAI_API_KEY=openai-dotenv-key'
    ].join('\n'), 'utf8');
    await writeFile(join(tempDir, '.env.local'), [
      'OPENAI_BASE_URL=https://openai-from-dotenv-local.example/v1',
      'OPENAI_API_KEY=openai-dotenv-local-key'
    ].join('\n'), 'utf8');

    const cli = buildCli({
      argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
      cwd: tempDir,
      createRuntime: (runtimeOptions) => {
        expect(runtimeOptions.baseUrl).toBe('https://openai-from-dotenv-local.example/v1');
        expect(runtimeOptions.apiKey).toBe('openai-dotenv-local-key');

        return {
          provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: runtimeOptions.cwd,
          observer: runtimeOptions.observer ?? { record() {} }
        };
      },
      stdout: { write() { return true; } },
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `handled: ${input.userInput}`,
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          toolEvidenceSatisfied: true,
          toolMessagesCount: 0,
          checks: []
        }
      })
    });

    await expect(cli.run()).resolves.toBe(0);
  });
```

- [ ] **Step 4: Run the targeted test again to verify `.env.local` still fails before implementation**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts
```

Expected: FAIL because `.env.local` is not loaded yet.

- [ ] **Step 5: Write the failing test for shell env beating env files**

```ts
  it('does not let env files overwrite variables already present in process.env', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-shell-'));
    tempDirs.push(tempDir);

    await writeFile(join(tempDir, '.env'), [
      'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
      'OPENAI_API_KEY=openai-dotenv-key'
    ].join('\n'), 'utf8');
    await writeFile(join(tempDir, '.env.local'), [
      'OPENAI_BASE_URL=https://openai-from-dotenv-local.example/v1',
      'OPENAI_API_KEY=openai-dotenv-local-key'
    ].join('\n'), 'utf8');

    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = 'https://openai-from-shell.example/v1';
    process.env.OPENAI_API_KEY = 'openai-shell-key';

    try {
      const cli = buildCli({
        argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions.baseUrl).toBe('https://openai-from-shell.example/v1');
          expect(runtimeOptions.apiKey).toBe('openai-shell-key');

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? { record() {} }
          };
        },
        stdout: { write() { return true; } },
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = previousBaseUrl;
      }

      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });
```

- [ ] **Step 6: Run the targeted test and verify shell env precedence still fails before implementation**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts
```

Expected: FAIL because the CLI currently has no env-file load/merge logic.

- [ ] **Step 7: Commit the red tests**

```bash
git add tests/cli/repl.test.ts
git commit -m "test: define CLI env autoload behavior"
```

### Task 2: Implement the CLI-local env loader

**Files:**
- Modify: `src/cli/main.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Add imports for file reading**

Update the import block in `src/cli/main.ts` from:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
```

to:

```ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
```

- [ ] **Step 2: Call the env loader before parsing CLI args**

In `buildCli(...).run()`, change:

```ts
      try {
        const parsed = parseArgs(argv);
        const providerConfig = resolveProviderConfig({
```

to:

```ts
      try {
        loadCliEnvFiles(cwd);
        const parsed = parseArgs(argv);
        const providerConfig = resolveProviderConfig({
```

- [ ] **Step 3: Add the minimal implementation for parsing and loading env files**

Add these helpers near the bottom of `src/cli/main.ts`, above `formatCliError`:

```ts
function loadCliEnvFiles(cwd: string): void {
  const originalEnvKeys = new Set(Object.keys(process.env));
  const fileLoadedKeys = new Set<string>();

  applyEnvFile(join(cwd, '.env'), originalEnvKeys, fileLoadedKeys);
  applyEnvFile(join(cwd, '.env.local'), originalEnvKeys, fileLoadedKeys);
}

function applyEnvFile(filePath: string, originalEnvKeys: Set<string>, fileLoadedKeys: Set<string>): void {
  if (!existsSync(filePath)) {
    return;
  }

  const fileContents = readFileSync(filePath, 'utf8');

  for (const [key, value] of parseEnvFile(fileContents)) {
    if (originalEnvKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
    fileLoadedKeys.add(key);
  }
}

function parseEnvFile(fileContents: string): Array<[string, string]> {
  return fileContents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => {
      const separatorIndex = line.indexOf('=');

      if (separatorIndex <= 0) {
        return [];
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();

      if (key.length === 0) {
        return [];
      }

      return [[key, value] as [string, string]];
    });
}
```

- [ ] **Step 4: Adjust the loader so `.env.local` can override `.env` without overriding shell env**

Replace `applyEnvFile(...)` with:

```ts
function applyEnvFile(filePath: string, originalEnvKeys: Set<string>, fileLoadedKeys: Set<string>): void {
  if (!existsSync(filePath)) {
    return;
  }

  const fileContents = readFileSync(filePath, 'utf8');

  for (const [key, value] of parseEnvFile(fileContents)) {
    if (originalEnvKeys.has(key) && !fileLoadedKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
    fileLoadedKeys.add(key);
  }
}
```

This is the key behavior:
- shell env present before startup stays untouched
- values loaded from `.env` can be replaced by `.env.local`

- [ ] **Step 5: Run the CLI test suite and verify the new tests pass**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts
```

Expected: PASS, including the new env-file tests.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/cli/main.ts tests/cli/repl.test.ts
git commit -m "feat: autoload CLI env files"
```

### Task 3: Ignore `.env.local` and verify no regressions

**Files:**
- Modify: `.gitignore`
- Test: `tests/cli/repl.test.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/session/session.test.ts`

- [ ] **Step 1: Add `.env.local` to git ignore**

Append this line to `.gitignore` if it is not already present:

```gitignore
.env.local
```

- [ ] **Step 2: Run the focused regression suite**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts tests/agent/loop.test.ts tests/session/session.test.ts
```

Expected: PASS with all targeted CLI, loop, and session tests green.

- [ ] **Step 3: Run typecheck**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" run typecheck:test
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run a real CLI smoke test from the workspace root**

Run:
```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw" run dev -- --provider openai --prompt "để chạy project QiClaw tôi cần dùng lệnh gì?"
```

Expected: the CLI no longer needs manual `source .env`; it should pick up values from `.env` / `.env.local` automatically and reach the configured provider. If the local provider rejects credentials, the request may still fail with an auth error, but missing-env errors should be gone.

- [ ] **Step 5: Commit the ignore update and verification-safe changes**

```bash
git add .gitignore
git commit -m "chore: ignore local env overrides"
```

## Self-review checklist

- Spec coverage: covered `.env`, `.env.local`, shell env precedence, CLI flag precedence, CLI-only scope, and `.gitignore` update.
- Placeholder scan: no `TODO`, `TBD`, or implicit “write tests” steps without concrete content.
- Type consistency: plan keeps all changes inside current CLI/testing boundaries and does not require provider API changes.
