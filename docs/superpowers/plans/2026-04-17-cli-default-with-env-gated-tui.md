# CLI Default With Env-Gated TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QiClaw default to the local CLI path and only attempt TUI launch when `.env` or `.env.local` sets `QICLAW_TUI_ENABLED=true`, while preserving fallback to CLI if TUI startup fails.

**Architecture:** Keep the behavior change at the CLI bootstrap boundary in [src/cli/main.ts](src/cli/main.ts). Route TUI launch through one exact-match env check, remove `--plain` from arg parsing, and update tests so they no longer depend on implicit `TTY => TUI` or on the removed `--plain` flag.

**Tech Stack:** TypeScript, Node.js, Vitest, existing QiClaw CLI/TUI bootstrap code

---

## File Map

### Existing files to modify

- `src/cli/main.ts`
  - Remove `--plain` parsing.
  - Gate TUI launch behind `process.env.QICLAW_TUI_ENABLED === 'true'` and TTY.
  - Keep `.env` / `.env.local` loading and fallback-to-plain behavior unchanged.
- `tests/cli/tuiFallbackRouting.test.ts`
  - Replace `--plain`-based routing tests with env-gated routing tests.
  - Add coverage for exact `true`, non-`true`, and fallback-on-launch-failure behavior.
- `tests/cli/repl.test.ts`
  - Add `QICLAW_TUI_ENABLED` to env snapshot helpers so tests cannot leak shell state.
  - Replace remaining `argv: ['--plain']` cases with the new default CLI behavior.
  - Add a parser regression test asserting `--plain` is now rejected as an unknown argument.

### Existing files to verify during implementation

- `src/cli/tuiLauncher.ts`
  - Confirm no change is needed because binary lookup and TUI bridge fallback behavior stay the same.
- `tests/cli/sessionMemoryFlow.test.ts`
  - Confirm no changes are needed because these tests do not rely on TUI launch gating.

---

## Notes before implementation

- Do not add a replacement CLI flag such as `--tui` or `--cli`.
- Only the exact string `true` enables TUI. `TRUE`, `1`, `yes`, empty string, and an absent variable must all keep the CLI path.
- Do not change `.env` loading precedence: `.env` first, `.env.local` second.
- Do not change `launchTui()` or `resolveTuiBinaryPath()` semantics.
- Keep the existing warning text `Falling back to plain mode: ...` when TUI startup throws.

---

### Task 1: Lock the new routing rules with failing tests

**Files:**
- Modify: `tests/cli/tuiFallbackRouting.test.ts`
- Modify: `tests/cli/repl.test.ts`
- Test: `tests/cli/tuiFallbackRouting.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Extend the shared env snapshot helper so `QICLAW_TUI_ENABLED` cannot leak between tests**

Update the `providerEnvKeys` constant near the top of `tests/cli/repl.test.ts`.

```ts
const providerEnvKeys = [
  'MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'QICLAW_DEBUG_LOG',
  'QICLAW_TUI_ENABLED'
] as const;
```

- [ ] **Step 2: Write the failing routing test for the new default CLI behavior**

Replace the first test in `tests/cli/tuiFallbackRouting.test.ts` with a no-flag version that proves TTY alone no longer launches TUI.

```ts
it('uses the local CLI path by default on interactive tty when QICLAW_TUI_ENABLED is not set', async () => {
  const launchTui = vi.fn(async () => {
    throw new Error('should not launch');
  });
  const writes: string[] = [];

  const cli = buildCli({
    cwd: '/tmp/qiclaw-cli-default',
    stdout: {
      isTTY: true,
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      }
    },
    stderr: {
      write() {
        return true;
      }
    },
    readLine: async () => undefined,
    launchTui
  });

  await expect(cli.run()).resolves.toBe(0);
  expect(launchTui).not.toHaveBeenCalled();
  expect(writes.join('')).toContain('Goodbye.');
});
```

- [ ] **Step 3: Write the failing routing test for exact-`true` TUI enablement**

Add this test in `tests/cli/tuiFallbackRouting.test.ts`.

```ts
it('tries TUI only when QICLAW_TUI_ENABLED is exactly true on an interactive tty', async () => {
  const launchTui = vi.fn(async () => 0);

  const previous = process.env.QICLAW_TUI_ENABLED;
  process.env.QICLAW_TUI_ENABLED = 'true';

  try {
    const cli = buildCli({
      cwd: '/tmp/qiclaw-tui-enabled',
      stdout: {
        isTTY: true,
        write() {
          return true;
        }
      },
      stderr: {
        write() {
          return true;
        }
      },
      readLine: async () => undefined,
      launchTui
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(launchTui).toHaveBeenCalledOnce();
  } finally {
    if (previous === undefined) {
      delete process.env.QICLAW_TUI_ENABLED;
    } else {
      process.env.QICLAW_TUI_ENABLED = previous;
    }
  }
});
```

- [ ] **Step 4: Write the failing routing test for non-`true` values staying on CLI**

Add this table-driven test in `tests/cli/tuiFallbackRouting.test.ts`.

```ts
it.each(['TRUE', '1', 'yes', 'false', ''])('does not launch TUI when QICLAW_TUI_ENABLED=%j', async (value) => {
  const launchTui = vi.fn(async () => {
    throw new Error('should not launch');
  });
  const previous = process.env.QICLAW_TUI_ENABLED;
  process.env.QICLAW_TUI_ENABLED = value;

  try {
    const cli = buildCli({
      cwd: `/tmp/qiclaw-tui-disabled-${String(value || 'empty')}`,
      stdout: {
        isTTY: true,
        write() {
          return true;
        }
      },
      stderr: {
        write() {
          return true;
        }
      },
      readLine: async () => undefined,
      launchTui
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(launchTui).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) {
      delete process.env.QICLAW_TUI_ENABLED;
    } else {
      process.env.QICLAW_TUI_ENABLED = previous;
    }
  }
});
```

- [ ] **Step 5: Update the existing fallback and controller-wiring tests to require env enablement**

Wrap the remaining TUI-path tests in `tests/cli/tuiFallbackRouting.test.ts` with `QICLAW_TUI_ENABLED='true'` instead of relying on TTY alone.

```ts
const previous = process.env.QICLAW_TUI_ENABLED;
process.env.QICLAW_TUI_ENABLED = 'true';

try {
  const cli = buildCli({
    cwd: '/tmp/qiclaw-tui-fallback',
    stdout: {
      isTTY: true,
      write(chunk: string | Uint8Array) {
        stdoutWrites.push(String(chunk));
        return true;
      }
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderrWrites.push(String(chunk));
        return true;
      }
    },
    readLine: async () => undefined,
    launchTui
  });

  await expect(cli.run()).resolves.toBe(0);
  expect(launchTui).toHaveBeenCalledOnce();
  expect(stderrWrites.join('')).toContain('Falling back to plain mode');
  expect(stdoutWrites.join('')).toContain('Goodbye.');
} finally {
  if (previous === undefined) {
    delete process.env.QICLAW_TUI_ENABLED;
  } else {
    process.env.QICLAW_TUI_ENABLED = previous;
  }
}
```

Use the same wrapper pattern for the controller-wiring test.

- [ ] **Step 6: Add the failing parser regression test for removed `--plain` support**

Add this test near the unknown-flag assertions in `tests/cli/repl.test.ts`.

```ts
it('returns exit code 1 and prints an error when --plain is provided', async () => {
  const stderrWrites: string[] = [];
  const cli = buildCli({
    argv: ['--plain'],
    stderr: {
      write(chunk) {
        stderrWrites.push(String(chunk));
        return true;
      }
    }
  });

  await expect(cli.run()).resolves.toBe(1);
  expect(stderrWrites).toEqual(['Unknown argument: --plain\n']);
});
```

- [ ] **Step 7: Run the focused routing and parser tests and verify they fail for the expected reasons**

Run:
```bash
npm test -- --run tests/cli/tuiFallbackRouting.test.ts tests/cli/repl.test.ts -t "plain|QICLAW_TUI_ENABLED|unknown argument"
```

Expected:
- `tuiFallbackRouting.test.ts` fails because the implementation still launches TUI on any interactive TTY.
- The new `--plain` parser regression test fails because `--plain` is still accepted.

- [ ] **Step 8: Commit the red test changes**

Run:
```bash
git add tests/cli/tuiFallbackRouting.test.ts tests/cli/repl.test.ts
git commit -m "test(cli): lock env-gated tui routing"
```

Expected: A commit is created containing only the new failing tests and helper update.

---

### Task 2: Implement env-gated mode selection and remove `--plain`

**Files:**
- Modify: `src/cli/main.ts`
- Test: `tests/cli/tuiFallbackRouting.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Remove the `plain` field from the parsed argv shape**

Update the return type of `parseArgs()` in `src/cli/main.ts`.

```ts
function parseArgs(argv: string[]): {
  prompt?: string;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  debugLogPath?: string;
  agentSpecName?: string;
  agentSpecPreviewName?: string;
} {
```

Also remove the `let plain = false;` local variable.

```ts
  let prompt: string | undefined;
  let provider = resolveDefaultProviderFromEnv();
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let debugLogPath: string | undefined;
  let agentSpecName: string | undefined;
  let agentSpecPreviewName: string | undefined;
```

- [ ] **Step 2: Delete the `--plain` parser branch and stop returning it**

Remove this block from `parseArgs()`:

```ts
    if (token === '--plain') {
      plain = true;
      continue;
    }
```

Return the remaining fields only.

```ts
  return {
    prompt,
    provider,
    model,
    baseUrl,
    apiKey,
    debugLogPath,
    agentSpecName,
    agentSpecPreviewName
  };
```

- [ ] **Step 3: Add a tiny exact-match helper for env-gated TUI launch**

Insert this helper above `buildCli()` in `src/cli/main.ts`.

```ts
function shouldLaunchTui(stdout: Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean }): boolean {
  return Boolean(stdout.isTTY) && process.env.QICLAW_TUI_ENABLED === 'true';
}
```

- [ ] **Step 4: Replace the old display-mode selection with the new env-gated rule**

Replace the current `displayMode` assignment in `buildCli()`.

```ts
        const displayMode: CliDisplayMode = parsed.prompt
          ? 'compact'
          : (shouldLaunchTui(stdout) ? 'interactive' : 'plain');
```

This keeps prompt mode untouched, launches TUI only through the new helper, and leaves all non-TUI execution on the existing CLI path.

- [ ] **Step 5: Run the focused routing/parser tests and verify they now pass**

Run:
```bash
npm test -- --run tests/cli/tuiFallbackRouting.test.ts tests/cli/repl.test.ts -t "plain|QICLAW_TUI_ENABLED|unknown argument"
```

Expected:
- PASS for the new default CLI routing test.
- PASS for the exact-`true` launch test.
- PASS for the non-`true` routing table.
- PASS for the `--plain` unknown-argument regression test.

- [ ] **Step 6: Commit the implementation change**

Run:
```bash
git add src/cli/main.ts
git commit -m "feat(cli): gate tui launch behind env"
```

Expected: A commit is created containing only the bootstrap/parser change.

---

### Task 3: Update the existing TTY interactive tests that still rely on `--plain`

**Files:**
- Modify: `tests/cli/repl.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Replace the first `argv: ['--plain']` case with the new default CLI behavior**

In the test `keeps streamed interactive text visible on TTY output with cursor controls`, remove the explicit `--plain` argv.

```ts
const cli = buildCli({
  cwd,
  readLine: (() => {
    const inputs = ['live text please', '/exit'];
    return async () => inputs.shift();
  })(),
  stdout: {
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    moveCursor(dx, dy) {
      writes.push(`\u001b[${Math.abs(dy)}A`);
      return true;
    },
    clearLine() {
      writes.push('\u001b[2K');
      return true;
    }
  } as Pick<NodeJS.WriteStream, 'write'> & {
    isTTY: boolean;
    moveCursor(dx: number, dy: number): boolean;
    clearLine(dir: -1 | 0 | 1): boolean;
  },
  createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
  runTurn: async (input) => ({
    // keep existing body unchanged
  })
});
```

- [ ] **Step 2: Replace the second and third `argv: ['--plain']` cases the same way**

Apply the same removal in these two tests in `tests/cli/repl.test.ts`:

- `keeps both streamed interactive text segments around later tool activity on TTY output`
- `falls back to raw ANSI line rewrites for interactive tool activity even when cursor methods exist`

For each one, change:

```ts
const cli = buildCli({
  argv: ['--plain'],
  cwd,
```

to:

```ts
const cli = buildCli({
  cwd,
```

Do not change the rest of those test bodies.

- [ ] **Step 3: Run the three updated TTY interactive tests to verify they still pass under the new default**

Run:
```bash
npm test -- --run tests/cli/repl.test.ts -t "keeps streamed interactive text visible on TTY output with cursor controls|keeps both streamed interactive text segments around later tool activity on TTY output|falls back to raw ANSI line rewrites for interactive tool activity even when cursor methods exist"
```

Expected: PASS for all three tests with no `--plain` flag present.

- [ ] **Step 4: Run the broader CLI/TUI suite to catch hidden routing assumptions**

Run:
```bash
npm test -- --run tests/cli/repl.test.ts tests/cli/tuiFallbackRouting.test.ts tests/cli/tuiLauncher.test.ts
```

Expected: PASS for all three files. If something still assumes `TTY => TUI` or `--plain`, update that test in place before moving on.

- [ ] **Step 5: Commit the test cleanup**

Run:
```bash
git add tests/cli/repl.test.ts tests/cli/tuiFallbackRouting.test.ts
git commit -m "test(cli): remove plain flag assumptions"
```

Expected: A commit is created containing only the final test cleanup and parser regression assertions.

---

### Task 4: Final verification

**Files:**
- Verify: `src/cli/main.ts`
- Verify: `tests/cli/repl.test.ts`
- Verify: `tests/cli/tuiFallbackRouting.test.ts`
- Verify: `tests/cli/tuiLauncher.test.ts`

- [ ] **Step 1: Run the full related test command**

Run:
```bash
npm test -- tests/cli/repl.test.ts tests/cli/tuiFallbackRouting.test.ts tests/cli/tuiLauncher.test.ts
```

Expected: PASS with no failures.

- [ ] **Step 2: Verify the final implementation diff is limited to the intended files**

Run:
```bash
git diff -- src/cli/main.ts tests/cli/repl.test.ts tests/cli/tuiFallbackRouting.test.ts
```

Expected: The diff shows only env-gated TUI launch logic, `--plain` removal, env snapshot coverage, and test updates.

- [ ] **Step 3: Verify the removed flag now errors exactly as intended**

Run:
```bash
npm test -- --run tests/cli/repl.test.ts -t "returns exit code 1 and prints an error when --plain is provided"
```

Expected: PASS and the assertion checks `Unknown argument: --plain`.

- [ ] **Step 4: Create the final verification commit**

Run:
```bash
git add src/cli/main.ts tests/cli/repl.test.ts tests/cli/tuiFallbackRouting.test.ts
git commit -m "refactor(cli): default to cli unless tui is enabled"
```

Expected: A clean final commit exists if you chose to squash the earlier task commits into one final commit instead of keeping the task-by-task history.

---

## Self-review checklist

### Spec coverage

- Default CLI behavior without env: covered by Task 1 routing test and Task 2 implementation.
- Exact `QICLAW_TUI_ENABLED=true` enablement: covered by Task 1 and Task 2.
- Non-`true` values stay on CLI: covered by Task 1.
- Fallback to CLI when TUI launch fails: covered by Task 1 preserved-path tests and Task 2 unchanged fallback logic.
- Remove `--plain`: covered by Task 1 parser regression test and Task 2 parser removal.
- Existing interactive TTY tests continue to work: covered by Task 3.

### Placeholder scan

- No `TODO`, `TBD`, or “update as needed” placeholders remain.
- Every changed file is named explicitly.
- Every test and command has a concrete expected outcome.

### Type consistency

- The env key is consistently named `QICLAW_TUI_ENABLED` everywhere.
- The helper function is consistently named `shouldLaunchTui`.
- The preserved fallback warning remains `Falling back to plain mode: ...`.
- The removed flag error remains `Unknown argument: --plain`.
