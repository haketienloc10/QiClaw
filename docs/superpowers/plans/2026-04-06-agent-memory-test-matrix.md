# Agent Memory Test Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reviewable implementation plan for the agent memory test matrix deliverable and keep the research spec aligned with the current test file layout already present in the repository.
**Architecture:** The deliverable is documentation-only. Keep the research source of truth in `docs/research/agent-memory-test-matrix.md` and add a matching implementation plan under `docs/superpowers/plans/` that describes the completed sections, current file anchors, and verification expectations.
**Tech Stack:** Markdown documentation, existing docs layout, current Vitest test file structure as mapping targets

---

## File structure

- `docs/research/agent-memory-test-matrix.md`
  - Source-of-truth research spec containing Purpose/scoring model, Coverage map A/B/C/D, Failure diagnosis taxonomy, test matrix A/B/C, Benchmark rubric, Priority guide, and Implementation mapping summary.
- `docs/superpowers/plans/2026-04-06-agent-memory-test-matrix.md`
  - Short implementation plan describing the documentation deliverable, review checkpoints, and verification criteria.

## Tasks

### Task 1: Confirm the delivered research spec sections

**Files:**
- Review: `docs/research/agent-memory-test-matrix.md`

- [ ] Verify the research document includes the intended sections: Purpose, scoring model, Coverage map A/B/C/D, Failure diagnosis taxonomy, A/B/C test matrices, Benchmark rubric, Priority guide, and Implementation mapping summary.
- [ ] Confirm the matrix remains documentation-only and does not require runtime code changes.

### Task 2: Add the missing implementation plan file

**Files:**
- Create: `docs/superpowers/plans/2026-04-06-agent-memory-test-matrix.md`

- [ ] Add the required plan header and metadata block.
- [ ] Summarize the actual deliverable already implemented in the research document.
- [ ] Describe the expected file structure and reviewer-facing verification points.

### Task 3: Align implementation mapping with the current repository layout

**Files:**
- Modify: `docs/research/agent-memory-test-matrix.md`

- [ ] Keep only existing files in the `Implementation mapping summary` table under `Primary files`.
- [ ] Remove `tests/context/promptBuilder.test.ts` and `tests/agent/loop.memory-integration.test.ts` from the current mapping table.
- [ ] If optional future test files are mentioned, place them outside the table and explicitly mark them as potential future files that do not exist yet and are not part of the current mapping.

## Verification

- [ ] Run `test -f docs/superpowers/plans/2026-04-06-agent-memory-test-matrix.md` to confirm the missing plan now exists.
- [ ] Run a grep check to confirm the research doc still contains the A/B/C matrix section headers.
- [ ] Run grep checks to confirm `promptBuilder.test.ts` and `loop.memory-integration.test.ts` are no longer part of the current implementation mapping.

## Self-review

- [ ] The plan is concise, reviewer-readable, and matches the delivered documentation scope.
- [ ] The research doc's implementation mapping references only files that currently exist.
- [ ] No runtime code, tests, or unrelated docs were modified.
