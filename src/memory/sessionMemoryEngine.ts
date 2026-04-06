import { existsSync } from 'node:fs';

import { allocateContextBudget } from '../context/budgetManager.js';
import type { Message } from '../core/types.js';
import { MemvidSessionStore } from './memvidSessionStore.js';
import { GlobalMemoryStore } from './globalMemoryStore.js';
import { ensureSessionStoreWriteReady, verifySessionStoreOnOpen } from './sessionMemoryMaintenance.js';
import { scoreSessionMemoryCandidate } from './decay.js';
import { assignMemoryFidelity } from './fidelity.js';
import { buildInteractiveTurnMemoryEntry, shouldCapture } from './capture.js';
import { shouldUseCompactMemoryRendering } from './recall.js';
import type {
  SessionMemoryCandidate,
  SessionMemoryCheckpointMetadata,
  SessionMemoryEntry
} from './sessionMemoryTypes.js';

const DEFAULT_MEMORY_CONTEXT_TOTAL_CHARS = 4_000;
const DEFAULT_RECALL_LIMIT = 5;

export interface SessionMemoryCheckpointState extends SessionMemoryCheckpointMetadata {}

export interface RecallSessionMemoriesInput {
  candidates: SessionMemoryCandidate[];
  budgetChars: number;
  now?: string;
}

export interface RecallSessionMemoriesResult {
  memoryText: string;
  usedBudgetChars: number;
  recalled: SessionMemoryCandidate[];
}

export interface PrepareInteractiveSessionMemoryInput {
  cwd: string;
  sessionId: string;
  userInput: string;
  historySummary?: string;
  checkpointState?: SessionMemoryCheckpointState;
  totalBudgetChars?: number;
  recallLimit?: number;
  now?: string;
}

export interface PrepareInteractiveSessionMemoryResult {
  memoryText: string;
  store: MemvidSessionStore;
  globalStore?: GlobalMemoryStore;
  recalled: SessionMemoryCandidate[];
  checkpointState: SessionMemoryCheckpointState;
}

export interface CaptureInteractiveTurnMemoryInput {
  store: MemvidSessionStore;
  sessionId: string;
  userInput: string;
  finalAnswer: string;
  history?: Message[];
  sourceTurnId?: string;
  now?: string;
}

export interface CaptureInteractiveTurnMemoryResult {
  saved: boolean;
  entry?: SessionMemoryEntry;
  checkpointState: SessionMemoryCheckpointState;
}

export async function prepareInteractiveSessionMemory(
  input: PrepareInteractiveSessionMemoryInput
): Promise<PrepareInteractiveSessionMemoryResult> {
  const store = new MemvidSessionStore({ cwd: input.cwd, sessionId: input.sessionId });
  const globalStore = new GlobalMemoryStore();
  const memoryPath = store.paths().memoryPath;
  const hadExistingStore = Boolean(input.checkpointState?.memoryPath) || existsSync(memoryPath);

  await store.open();
  await globalStore.open();
  let meta = await store.readMeta();

  const verifyResult = await verifySessionStoreOnOpen({
    store,
    meta,
    exists: hadExistingStore,
    now: input.now
  });

  if (verifyResult.meta?.lastVerifiedAt) {
    meta = {
      ...meta,
      lastVerifiedAt: verifyResult.meta.lastVerifiedAt
    };
    await store.writeMeta(meta);
  }

  const recallLimit = Math.max(1, input.recallLimit ?? DEFAULT_RECALL_LIMIT);
  const candidates = await recallInteractiveCandidates({
    store,
    globalStore,
    userInput: input.userInput,
    historySummary: input.historySummary,
    latestSummaryText: input.checkpointState?.latestSummaryText,
    recallLimit
  });
  const allocation = allocateContextBudget({ total: Math.max(0, Math.floor(input.totalBudgetChars ?? DEFAULT_MEMORY_CONTEXT_TOTAL_CHARS)) });
  const recall = recallSessionMemories({
    candidates,
    budgetChars: allocation.buckets.memory,
    now: input.now
  });

  if (recall.recalled.length > 0) {
    const sessionHashes = recall.recalled.filter((candidate) => candidate.sessionId === input.sessionId).map((candidate) => candidate.hash);
    const globalHashes = recall.recalled.filter((candidate) => candidate.sessionId === 'user-global').map((candidate) => candidate.hash);

    if (sessionHashes.length > 0) {
      await store.touchByHashes(sessionHashes);
    }

    if (globalHashes.length > 0) {
      await globalStore.touchByHashes(globalHashes);
    }
  }

  return {
    memoryText: recall.memoryText,
    store,
    globalStore,
    recalled: recall.recalled,
    checkpointState: {
      storeSessionId: input.sessionId,
      engine: meta.engine,
      version: meta.version,
      memoryPath: meta.memoryPath,
      metaPath: meta.metaPath,
      totalEntries: meta.totalEntries,
      lastCompactedAt: meta.lastCompactedAt,
      latestSummaryText: input.checkpointState?.latestSummaryText
    }
  };
}

export async function captureInteractiveTurnMemory(
  input: CaptureInteractiveTurnMemoryInput
): Promise<CaptureInteractiveTurnMemoryResult> {
  const entry = buildInteractiveTurnMemoryEntry({
    sessionId: input.sessionId,
    userInput: input.userInput,
    finalAnswer: input.finalAnswer,
    history: input.history,
    sourceTurnId: input.sourceTurnId,
    now: input.now
  });

  if (!entry || !shouldCapture(entry)) {
    const meta = await input.store.readMeta();

    return {
      saved: false,
      checkpointState: {
        storeSessionId: input.sessionId,
        engine: meta.engine,
        version: meta.version,
        memoryPath: meta.memoryPath,
        metaPath: meta.metaPath,
        totalEntries: meta.totalEntries,
        lastCompactedAt: meta.lastCompactedAt
      }
    };
  }

  const memoryPath = input.store.paths().memoryPath;
  await ensureSessionStoreWriteReady({
    store: input.store,
    meta: { memoryPath },
    exists: existsSync(memoryPath),
    now: input.now
  });

  await input.store.put(entry);
  await input.store.seal();

  if (shouldCaptureGlobalMemory(entry)) {
    const globalStore = new GlobalMemoryStore();
    await globalStore.open();
    await globalStore.put(entry);
    await globalStore.seal();
  }

  const meta = await input.store.readMeta();

  return {
    saved: true,
    entry,
    checkpointState: {
      storeSessionId: input.sessionId,
      engine: meta.engine,
      version: meta.version,
      memoryPath: meta.memoryPath,
      metaPath: meta.metaPath,
      totalEntries: meta.totalEntries,
      lastCompactedAt: meta.lastCompactedAt,
      latestSummaryText: entry.summaryText
    }
  };
}

export function recallSessionMemories(input: RecallSessionMemoriesInput): RecallSessionMemoriesResult {
  const budgetChars = Math.max(0, input.budgetChars);

  if (budgetChars === 0 || input.candidates.length === 0) {
    return {
      memoryText: '',
      usedBudgetChars: 0,
      recalled: []
    };
  }

  const scored = input.candidates
    .map((candidate) => ({
      ...candidate,
      finalScore: scoreSessionMemoryCandidate(candidate, { now: input.now })
    }))
    .sort((left, right) => right.finalScore - left.finalScore);

  const hot: string[] = [];
  const warm: string[] = [];
  const faded: string[] = [];
  const recalled: SessionMemoryCandidate[] = [];

  for (const [index, candidate] of scored.entries()) {
    const currentText = renderMemorySections(hot, warm, faded, budgetChars);
    const remainingChars = Math.max(0, budgetChars - currentText.length);
    const remainingCandidates = Math.max(1, scored.length - index);
    const perCandidateBudget = index === 0
      ? remainingChars
      : Math.max(8, Math.floor(remainingChars / remainingCandidates));
    const assigned = assignMemoryFidelity(candidate, {
      remainingChars: perCandidateBudget,
      hotThreshold: 1.5,
      warmThreshold: 1.15
    });
    const line = assigned.fidelity === 'hash'
      ? `- #${assigned.candidate.hash}`
      : formatMemoryLine(assigned.renderedText);
    const nextHot = assigned.fidelity === 'full' ? [...hot, line] : hot;
    const nextWarm = assigned.fidelity === 'summary' ? [...warm, line] : warm;
    const nextFaded = assigned.fidelity === 'full' || assigned.fidelity === 'summary'
      ? faded
      : [...faded, line];
    const nextText = renderMemorySections(nextHot, nextWarm, nextFaded, budgetChars);

    if (nextText.length > budgetChars) {
      if (assigned.fidelity === 'hash') {
        break;
      }

      continue;
    }

    recalled.push(assigned.candidate);

    if (assigned.fidelity === 'full') {
      hot.push(line);
    } else if (assigned.fidelity === 'summary') {
      warm.push(line);
    } else {
      faded.push(line);
    }
  }

  const memoryText = renderMemorySections(hot, warm, faded, budgetChars);

  if (memoryText.length === 0) {
    return {
      memoryText: '',
      usedBudgetChars: 0,
      recalled: []
    };
  }

  return {
    memoryText,
    usedBudgetChars: memoryText.length,
    recalled
  };
}

function formatMemoryLine(text: string): string {
  return `- ${text}`;
}

function renderMemorySections(hot: string[], warm: string[], faded: string[], budgetChars: number): string {
  if (hot.length === 0 && warm.length === 0 && faded.length === 0) {
    return '';
  }

  const allLines = [...hot, ...warm, ...faded];
  const compactText = ['Mem:', ...allLines].join('\n');

  if (shouldUseCompactMemoryRendering(compactText, budgetChars)) {
    return compactText;
  }

  const sections = ['Memory:'];

  if (hot.length > 0) {
    sections.push('Hot memories:', ...hot);
  }

  if (warm.length > 0) {
    sections.push('Warm summaries:', ...warm);
  }

  if (faded.length > 0) {
    sections.push('Faded references:', ...faded);
  }

  return sections.join('\n');
}

async function recallInteractiveCandidates(input: {
  store: MemvidSessionStore;
  globalStore: GlobalMemoryStore;
  userInput: string;
  historySummary?: string;
  latestSummaryText?: string;
  recallLimit: number;
}): Promise<SessionMemoryCandidate[]> {
  const queries = [input.userInput, input.historySummary, input.latestSummaryText].filter(isPresent);
  const deduped = new Map<string, SessionMemoryCandidate>();

  for (const query of queries) {
    const recalledGroups = await Promise.all([
      input.store.recall(query, { k: input.recallLimit }),
      input.globalStore.recall(query, { k: input.recallLimit })
    ]);

    for (const candidate of recalledGroups.flat()) {
      const dedupeKey = `${normalizeMemoryText(candidate.summaryText)}\n${normalizeMemoryText(candidate.essenceText)}`;
      const existing = deduped.get(dedupeKey);
      if (!existing || scoreMergedCandidate(candidate) > scoreMergedCandidate(existing)) {
        deduped.set(dedupeKey, candidate);
      }
    }
  }

  return [...deduped.values()];
}

function shouldCaptureGlobalMemory(entry: SessionMemoryEntry): boolean {
  if (containsSensitiveMemoryContent(entry)) {
    return false;
  }

  if (entry.explicitSave) {
    return true;
  }

  if (entry.memoryType === 'fact') {
    return entry.importance >= 0.72;
  }

  if (entry.memoryType === 'procedure') {
    return entry.importance >= 0.8;
  }

  return false;
}

function containsSensitiveMemoryContent(entry: SessionMemoryEntry): boolean {
  const content = `${entry.summaryText}\n${entry.essenceText}\n${entry.fullText}`;
  return /\b(api[_-]?key|token|secret|password|passwd|private[_-]?key|credential|\.env)\b/iu.test(content);
}

function scoreMergedCandidate(candidate: SessionMemoryCandidate): number {
  const scopeBoost = candidate.sessionId === 'user-global'
    ? (candidate.explicitSave ? 0.1 : -0.03)
    : 0.05;
  return candidate.retrievalScore + candidate.importance + scopeBoost;
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
