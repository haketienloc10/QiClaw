import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { BlueprintStore } from './store.js';
import type {
  BlueprintBranch,
  BlueprintEvidenceRequirement,
  BlueprintFailureMode,
  BlueprintPrecondition,
  BlueprintRecord,
  BlueprintStep,
  BlueprintTrigger
} from './types.js';

const STEP_KINDS = new Set<BlueprintStep['kind']>(['inspect', 'act', 'verify', 'communicate']);
const EVIDENCE_KINDS = new Set<BlueprintEvidenceRequirement['kind']>(['tool_result', 'final_answer', 'state_change', 'user_confirmation']);
const RUNTIME_ONLY_FIELDS = new Set(['createdAt', 'updatedAt', 'status', 'stats', 'markdownPath', 'sourceContentHash']);

interface BlueprintAuthoringDocument {
  version: number;
  blueprints: BlueprintAuthoringRecord[];
}

interface BlueprintAuthoringRecord {
  id: string;
  title: string;
  goal: string;
  trigger: BlueprintTrigger;
  preconditions: BlueprintPrecondition[];
  steps: BlueprintStep[];
  branches: BlueprintBranch[];
  expectedEvidence: BlueprintEvidenceRequirement[];
  failureModes: BlueprintFailureMode[];
  tags: string[];
  supersedesBlueprintId?: string;
}

export interface ImportBlueprintJsonInput {
  inputPath: string;
  storeDirectory?: string;
  sourceLabel?: string;
}

export interface ImportBlueprintJsonResult {
  importedCount: number;
  supersededCount: number;
  importedIds: string[];
}

export async function importBlueprintJson(input: ImportBlueprintJsonInput): Promise<ImportBlueprintJsonResult> {
  const documents = await loadAuthoringDocuments(input.inputPath);
  const importedIds: string[] = [];
  let supersededCount = 0;
  const sourceLabel = input.sourceLabel ?? 'manual:blueprint-json-import';
  const store = new BlueprintStore({ baseDirectory: input.storeDirectory });
  await store.open();

  for (const document of documents) {
    const records = parseBlueprintDocument(document.filePath, document.content, sourceLabel);

    for (const record of records) {
      await store.put(record);
      importedIds.push(record.id);

      if (record.supersedesBlueprintId) {
        const supersededBlueprint = await store.getById(record.supersedesBlueprintId);
        if (!supersededBlueprint) {
          throw new Error(`Blueprint import failed for ${document.filePath}: supersedesBlueprintId "${record.supersedesBlueprintId}" does not exist.`);
        }

        await store.supersedeBlueprint(record.supersedesBlueprintId, record.updatedAt);
        supersededCount += 1;
      }
    }
  }

  await store.seal();

  return {
    importedCount: importedIds.length,
    supersededCount,
    importedIds
  };
}

async function loadAuthoringDocuments(inputPath: string): Promise<Array<{ filePath: string; content: string }>> {
  const stat = await import('node:fs/promises').then(({ stat: loadStat }) => loadStat(inputPath));

  if (stat.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
      .map((entry) => join(inputPath, entry.name))
      .sort((left, right) => basename(left).localeCompare(basename(right)));

    if (files.length === 0) {
      throw new Error(`Blueprint import failed: no JSON files found in ${inputPath}.`);
    }

    return Promise.all(files.map(async (filePath) => ({
      filePath,
      content: await readFile(filePath, 'utf8')
    })));
  }

  return [{
    filePath: inputPath,
    content: await readFile(inputPath, 'utf8')
  }];
}

function parseBlueprintDocument(filePath: string, content: string, sourceLabel: string): BlueprintRecord[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalizeLineEndings(content));
  } catch (error) {
    throw new Error(`Blueprint import failed for ${filePath}: invalid JSON. ${formatErrorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Blueprint import failed for ${filePath}: top-level payload must be an object.`);
  }

  const document = parsed as Partial<BlueprintAuthoringDocument> & Record<string, unknown>;
  if (document.version !== 1) {
    throw new Error(`Blueprint import failed for ${filePath}: version must be 1.`);
  }

  if (!Array.isArray(document.blueprints) || document.blueprints.length === 0) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprints must be a non-empty array.`);
  }

  const seenIds = new Set<string>();
  return document.blueprints.map((blueprint, index) => {
    const authoringRecord = parseAuthoringRecord(filePath, blueprint, index);
    if (seenIds.has(authoringRecord.id)) {
      throw new Error(`Blueprint import failed for ${filePath}: duplicate blueprint id "${authoringRecord.id}".`);
    }
    seenIds.add(authoringRecord.id);
    return toBlueprintRecord(authoringRecord, sourceLabel);
  });
}

function parseAuthoringRecord(filePath: string, value: unknown, index: number): BlueprintAuthoringRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint at index ${index} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  for (const field of RUNTIME_ONLY_FIELDS) {
    if (field in record) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint "${readString(record.id) ?? `#${index}`}" must not include runtime-only field "${field}".`);
    }
  }

  const id = requireString(filePath, record.id, `blueprint[${index}].id`);
  const title = requireString(filePath, record.title, `blueprint[${index}].title`);
  const goal = requireString(filePath, record.goal, `blueprint[${index}].goal`);
  const trigger = parseTrigger(filePath, record.trigger, index);
  const preconditions = parsePreconditions(filePath, record.preconditions, index);
  const steps = parseSteps(filePath, record.steps, index);
  const branches = parseBranches(filePath, record.branches, index);
  const expectedEvidence = parseExpectedEvidence(filePath, record.expectedEvidence, index);
  const failureModes = parseFailureModes(filePath, record.failureModes, index);
  const tags = parseStringArray(filePath, record.tags, `blueprint[${index}].tags`);
  const supersedesBlueprintId = readOptionalString(filePath, record.supersedesBlueprintId, `blueprint[${index}].supersedesBlueprintId`);

  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    if (step.nextStepId && !stepIds.has(step.nextStepId)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint "${id}" nextStepId "${step.nextStepId}" does not exist.`);
    }
  }

  for (const branch of branches) {
    if (!stepIds.has(branch.gotoStepId)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint "${id}" gotoStepId "${branch.gotoStepId}" does not exist.`);
    }
  }

  return {
    id,
    title,
    goal,
    trigger,
    preconditions,
    steps,
    branches,
    expectedEvidence,
    failureModes,
    tags,
    supersedesBlueprintId
  };
}

function toBlueprintRecord(record: BlueprintAuthoringRecord, sourceLabel: string): BlueprintRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    source: sourceLabel,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    stats: {
      useCount: 0,
      successCount: 0,
      failureCount: 0
    }
  };
}

function parseTrigger(filePath: string, value: unknown, index: number): BlueprintTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].trigger must be an object.`);
  }

  const trigger = value as Record<string, unknown>;
  return {
    title: requireString(filePath, trigger.title, `blueprint[${index}].trigger.title`),
    patterns: requireNonEmptyStringArray(filePath, trigger.patterns, `blueprint[${index}].trigger.patterns`),
    tags: parseStringArray(filePath, trigger.tags, `blueprint[${index}].trigger.tags`)
  };
}

function parsePreconditions(filePath: string, value: unknown, index: number): BlueprintPrecondition[] {
  if (!Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].preconditions must be an array.`);
  }

  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].preconditions[${itemIndex}] must be an object.`);
    }

    const precondition = item as Record<string, unknown>;
    return {
      description: requireString(filePath, precondition.description, `blueprint[${index}].preconditions[${itemIndex}].description`),
      required: readOptionalBoolean(filePath, precondition.required, `blueprint[${index}].preconditions[${itemIndex}].required`)
    };
  });
}

function parseSteps(filePath: string, value: unknown, index: number): BlueprintStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].steps must be a non-empty array.`);
  }

  const seenIds = new Set<string>();
  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].steps[${itemIndex}] must be an object.`);
    }

    const step = item as Record<string, unknown>;
    const id = requireString(filePath, step.id, `blueprint[${index}].steps[${itemIndex}].id`);
    if (seenIds.has(id)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}] has duplicate step id "${id}".`);
    }
    seenIds.add(id);

    const kind = requireString(filePath, step.kind, `blueprint[${index}].steps[${itemIndex}].kind`) as BlueprintStep['kind'];
    if (!STEP_KINDS.has(kind)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].steps[${itemIndex}].kind must be one of ${[...STEP_KINDS].join(', ')}.`);
    }

    return {
      id,
      title: requireString(filePath, step.title, `blueprint[${index}].steps[${itemIndex}].title`),
      instruction: requireString(filePath, step.instruction, `blueprint[${index}].steps[${itemIndex}].instruction`),
      kind,
      expectedEvidence: readOptionalStringArray(filePath, step.expectedEvidence, `blueprint[${index}].steps[${itemIndex}].expectedEvidence`),
      onFailure: readOptionalString(filePath, step.onFailure, `blueprint[${index}].steps[${itemIndex}].onFailure`),
      nextStepId: readOptionalString(filePath, step.nextStepId, `blueprint[${index}].steps[${itemIndex}].nextStepId`)
    };
  });
}

function parseBranches(filePath: string, value: unknown, index: number): BlueprintBranch[] {
  if (!Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].branches must be an array.`);
  }

  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].branches[${itemIndex}] must be an object.`);
    }

    const branch = item as Record<string, unknown>;
    return {
      id: requireString(filePath, branch.id, `blueprint[${index}].branches[${itemIndex}].id`),
      condition: requireString(filePath, branch.condition, `blueprint[${index}].branches[${itemIndex}].condition`),
      gotoStepId: requireString(filePath, branch.gotoStepId, `blueprint[${index}].branches[${itemIndex}].gotoStepId`)
    };
  });
}

function parseExpectedEvidence(filePath: string, value: unknown, index: number): BlueprintEvidenceRequirement[] {
  if (!Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].expectedEvidence must be an array.`);
  }

  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].expectedEvidence[${itemIndex}] must be an object.`);
    }

    const evidence = item as Record<string, unknown>;
    const kind = requireString(filePath, evidence.kind, `blueprint[${index}].expectedEvidence[${itemIndex}].kind`) as BlueprintEvidenceRequirement['kind'];
    if (!EVIDENCE_KINDS.has(kind)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].expectedEvidence[${itemIndex}].kind must be one of ${[...EVIDENCE_KINDS].join(', ')}.`);
    }

    return {
      description: requireString(filePath, evidence.description, `blueprint[${index}].expectedEvidence[${itemIndex}].description`),
      kind,
      required: requireBoolean(filePath, evidence.required, `blueprint[${index}].expectedEvidence[${itemIndex}].required`)
    };
  });
}

function parseFailureModes(filePath: string, value: unknown, index: number): BlueprintFailureMode[] {
  if (!Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].failureModes must be an array.`);
  }

  return value.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Blueprint import failed for ${filePath}: blueprint[${index}].failureModes[${itemIndex}] must be an object.`);
    }

    const failureMode = item as Record<string, unknown>;
    return {
      title: requireString(filePath, failureMode.title, `blueprint[${index}].failureModes[${itemIndex}].title`),
      signals: parseStringArray(filePath, failureMode.signals, `blueprint[${index}].failureModes[${itemIndex}].signals`),
      mitigation: readOptionalString(filePath, failureMode.mitigation, `blueprint[${index}].failureModes[${itemIndex}].mitigation`)
    };
  });
}

function requireString(filePath: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Blueprint import failed for ${filePath}: ${label} must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalString(filePath: string, value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(filePath, value, label);
}

function readOptionalBoolean(filePath: string, value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireBoolean(filePath, value, label);
}

function requireBoolean(filePath: string, value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Blueprint import failed for ${filePath}: ${label} must be a boolean.`);
  }

  return value;
}

function parseStringArray(filePath: string, value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Blueprint import failed for ${filePath}: ${label} must be an array.`);
  }

  return value.map((item, index) => requireString(filePath, item, `${label}[${index}]`));
}

function requireNonEmptyStringArray(filePath: string, value: unknown, label: string): string[] {
  const values = parseStringArray(filePath, value, label);
  if (values.length === 0) {
    throw new Error(`Blueprint import failed for ${filePath}: ${label} must be a non-empty array.`);
  }
  return values;
}

function readOptionalStringArray(filePath: string, value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseStringArray(filePath, value, label);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
