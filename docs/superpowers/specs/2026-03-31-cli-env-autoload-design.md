# CLI env autoload design

## Goal
Make the QiClaw CLI automatically load provider credentials and endpoint overrides from local env files so the user can run the CLI without manually exporting variables each time.

## Scope
- Load `.env` and `.env.local` from the CLI working directory.
- Apply this only in the CLI startup path.
- Keep existing provider config precedence intact.
- Ignore `.env.local` in git.
- Add tests for env-file precedence and CLI override behavior.

## Out of scope
- Adding a new dependency such as `dotenv`.
- Loading env files from provider modules or other runtime modules.
- Supporting additional env file variants such as `.env.production`.
- Changing existing provider env variable names.

## Chosen approach
Implement a small CLI-local env loader in [src/cli/main.ts](src/cli/main.ts).

The CLI startup sequence becomes:
1. Read `.env` from `cwd` if present.
2. Read `.env.local` from `cwd` if present.
3. Merge file values so `.env.local` overrides `.env`.
4. Do not overwrite variables already present in `process.env`.
5. Parse CLI flags.
6. Resolve provider config as today.

This preserves the intended precedence:
- Highest: CLI flags
- Next: shell environment
- Next: `.env.local`
- Next: `.env`
- Lowest: code defaults for model only

## Why this approach
- Smallest change that solves the user problem.
- Keeps env-file behavior explicit at the CLI boundary.
- Avoids introducing a dependency for a simple `KEY=value` use case.
- Avoids changing provider modules, which should continue reading resolved config or `process.env` only.

## Design details
### Loader behavior
The loader should:
- Look only in the current CLI working directory.
- Treat missing files as normal.
- Parse simple `KEY=value` lines.
- Ignore blank lines.
- Ignore comment lines starting with `#`.
- Set parsed values onto `process.env` only when that key is currently unset.

To support `.env.local` overriding `.env` while still preserving shell env precedence, the implementation should:
- Track which keys were loaded from files during this startup.
- Allow `.env.local` to replace keys previously loaded from `.env`.
- Refuse to replace keys that were already present before file loading began.

### CLI boundary
The loader runs before `parseArgs(...)` and before `resolveProviderConfig(...)` in [src/cli/main.ts](src/cli/main.ts).

No provider-specific logic is added to the loader. It only populates `process.env`.

### Git ignore
Add `.env.local` to [.gitignore](.gitignore) so local overrides stay untracked.

## Testing
Add tests in [tests/cli/repl.test.ts](tests/cli/repl.test.ts) for:
- loading values from `.env`
- `.env.local` overriding `.env`
- pre-existing shell env values not being overwritten by file values
- CLI flags still overriding env-file values

The tests should use temp directories and real files so behavior is exercised through the actual CLI startup boundary.

## Risks and mitigations
- Risk: simplistic parsing could mis-handle advanced dotenv syntax.
  - Mitigation: keep the parser intentionally narrow and document that only simple `KEY=value` lines are supported.
- Risk: env-file loading could accidentally affect non-CLI code paths.
  - Mitigation: keep loading inside the CLI startup path only.

## Acceptance criteria
- Running QiClaw from a directory containing `.env` and/or `.env.local` automatically makes those values available to provider config resolution.
- `.env.local` overrides `.env`.
- existing shell env values still win over both files.
- CLI flags still win over shell env and env files.
- `.env.local` is ignored by git.
