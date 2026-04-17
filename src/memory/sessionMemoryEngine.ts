import { existsSync } from 'node:fs';

import { allocateContextBudget } from '../context/budgetManager.js';
import type { Message } from '../core/types.js';
import { FileSessionStore } from './fileSessionStore.js';
import { GlobalMemoryStore } from './globalMemoryStore.js';
import { ensureSessionStoreWriteReady, verifySessionStoreOnOpen } from './sessionMemoryMaintenance.js';
import { scoreSessionMemoryCandidate } from './decay.js';
import { assignMemoryFidelity } from './fidelity.js';
import { buildCandidateMemoryAction, buildInteractiveTurnMemoryEntry, shouldCapture } from './capture.js';
import type { ModelMemoryCandidate } from '../agent/loop.js';
import { shouldUseCompactMemoryRendering } from './recall.js';
import type { MemoryEmbeddingConfig } from './memoryEmbeddingConfig.js';
import {
  buildPersistedMemoryRecord,
  type PersistedSessionMemoryRecord,
  type SessionMemoryCandidate,
  type SessionMemoryCheckpointMetadata,
  type SessionMemoryEntry
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

export interface RecallDebugHit {
  hash: string;
  sessionId: string;
  kind: SessionMemoryCandidate['kind'];
  summaryText: string;
  source: string;
  retrievalScore: number;
  importance: number;
  explicitSave: boolean;
}

export interface RecallDebugQueryResult {
  source: 'userInput' | 'historySummary' | 'latestSummaryText';
  query: string;
  sessionHits: RecallDebugHit[];
  globalHits: RecallDebugHit[];
}

export interface RecallDebugQueryOverview {
  source: 'userInput' | 'historySummary' | 'latestSummaryText';
  query: string;
  sessionHitCount: number;
  globalHitCount: number;
  totalHitCount: number;
}

export interface RecallDebugFinalOverview {
  finalResultCount: number;
  sessionFinalCount: number;
  globalFinalCount: number;
}

export interface RecallInputsDebugRecord {
  type: 'memory_recall_inputs';
  timestamp: string;
  sessionId: string;
  userInput: string;
  historySummary?: string;
  latestSummaryText?: string;
  queries: string[];
  queryCount: number;
  userInputLength: number;
  historySummaryLength: number;
  latestSummaryTextLength: number;
  queryOverview: RecallDebugQueryOverview[];
  queryResults: RecallDebugQueryResult[];
  finalOverview: RecallDebugFinalOverview;
  finalResults: RecallDebugHit[];
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
  debugRecallInputs?: (record: RecallInputsDebugRecord) => void;
  memoryConfig?: MemoryEmbeddingConfig;
}

export interface PrepareInteractiveSessionMemoryResult {
  memoryText: string;
  store: FileSessionStore;
  globalStore?: GlobalMemoryStore;
  recalled: SessionMemoryCandidate[];
  checkpointState: SessionMemoryCheckpointState;
}

export interface InspectInteractiveRecallInput {
  cwd: string;
  sessionId: string;
  userInput: string;
  historySummary?: string;
  checkpointState?: SessionMemoryCheckpointState;
  recallLimit?: number;
  now?: string;
  debugRecallInputs?: (record: RecallInputsDebugRecord) => void;
  memoryConfig?: MemoryEmbeddingConfig;
}

export interface InspectInteractiveRecallResult {
  renderedText: string;
  recalled: SessionMemoryCandidate[];
}

export interface CaptureInteractiveTurnMemoryInput {
  store: FileSessionStore;
  sessionId: string;
  userInput: string;
  finalAnswer: string;
  history?: Message[];
  memoryCandidates?: ModelMemoryCandidate[];
  sourceTurnId?: string;
  now?: string;
  memoryConfig?: MemoryEmbeddingConfig;
}

export interface CaptureInteractiveTurnMemoryResult {
  saved: boolean;
  entry?: PersistedSessionMemoryRecord;
  checkpointState: SessionMemoryCheckpointState;
}

export async function prepareInteractiveSessionMemory(
  input: PrepareInteractiveSessionMemoryInput
): Promise<PrepareInteractiveSessionMemoryResult> {
  const store = new FileSessionStore({ cwd: input.cwd, sessionId: input.sessionId, memoryConfig: input.memoryConfig });
  const globalStore = new GlobalMemoryStore({ memoryConfig: input.memoryConfig });
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
    sessionId: input.sessionId,
    userInput: input.userInput,
    historySummary: input.historySummary,
    latestSummaryText: input.checkpointState?.latestSummaryText,
    recallLimit,
    now: input.now,
    debugRecallInputs: input.debugRecallInputs
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
  const candidateAction = buildCandidateMemoryAction({
    sessionId: input.sessionId,
    memoryCandidates: input.memoryCandidates,
    sourceTurnId: input.sourceTurnId,
    now: input.now ?? new Date().toISOString()
  });

  const memoryPath = input.store.paths().memoryPath;

  if (candidateAction?.operation === 'invalidate') {
    await ensureSessionStoreWriteReady({
      store: input.store,
      meta: { memoryPath },
      exists: existsSync(memoryPath),
      now: input.now
    });

    if ('invalidateByHashes' in input.store && typeof input.store.invalidateByHashes === 'function') {
      await input.store.invalidateByHashes(candidateAction.targetHashes, input.now ?? new Date().toISOString());
    }

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

  const rawEntry = candidateAction?.entry ?? buildInteractiveTurnMemoryEntry({
    sessionId: input.sessionId,
    userInput: input.userInput,
    finalAnswer: input.finalAnswer,
    history: input.history,
    memoryCandidates: input.memoryCandidates,
    sourceTurnId: input.sourceTurnId,
    now: input.now
  });

  if (!rawEntry || !shouldCapture(rawEntry)) {
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

  await ensureSessionStoreWriteReady({
    store: input.store,
    meta: { memoryPath },
    exists: existsSync(memoryPath),
    now: input.now
  });

  const persistedEntry = buildPersistedMemoryRecord({
    ...rawEntry,
    markdownPath: buildPendingMarkdownPath(input.store.paths().directoryPath, rawEntry)
  });

  if (candidateAction?.operation === 'refine' && 'supersedeByHashes' in input.store && typeof input.store.supersedeByHashes === 'function') {
    await input.store.supersedeByHashes(candidateAction.targetHashes, input.now ?? new Date().toISOString());
  }

  await input.store.put(rawEntry);
  await input.store.seal();

  if (shouldCaptureGlobalMemory(rawEntry)) {
    try {
      const globalStore = new GlobalMemoryStore({ memoryConfig: input.memoryConfig });
      await globalStore.open();
      if (candidateAction?.operation === 'refine' && 'supersedeByHashes' in globalStore && typeof globalStore.supersedeByHashes === 'function') {
        await globalStore.supersedeByHashes(candidateAction.targetHashes, input.now ?? new Date().toISOString());
      }
      await globalStore.put(rawEntry);
      await globalStore.seal();
    } catch {
      // Keep session memory capture best-effort even if global persistence fails.
    }
  }

  const meta = await input.store.readMeta();

  return {
    saved: true,
    entry: persistedEntry,
    checkpointState: {
      storeSessionId: input.sessionId,
      engine: meta.engine,
      version: meta.version,
      memoryPath: meta.memoryPath,
      metaPath: meta.metaPath,
      totalEntries: meta.totalEntries,
      lastCompactedAt: meta.lastCompactedAt,
      latestSummaryText: persistedEntry.summaryText
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
    .sort(compareSessionMemoryCandidates);

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

function compareSessionMemoryCandidates(left: SessionMemoryCandidate, right: SessionMemoryCandidate): number {
  const scoreComparison = right.finalScore - left.finalScore;

  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  if (left.explicitSave !== right.explicitSave) {
    return left.explicitSave ? -1 : 1;
  }

  const leftRecency = Math.max(safeTimestamp(Date.parse(left.lastAccessed)), safeTimestamp(Date.parse(left.createdAt)));
  const rightRecency = Math.max(safeTimestamp(Date.parse(right.lastAccessed)), safeTimestamp(Date.parse(right.createdAt)));
  const recencyComparison = rightRecency - leftRecency;

  if (recencyComparison !== 0) {
    return recencyComparison;
  }

  const hashComparison = left.hash.localeCompare(right.hash);

  if (hashComparison !== 0) {
    return hashComparison;
  }

  return left.source.localeCompare(right.source);
}

function safeTimestamp(value: number): number {
  return Number.isNaN(value) ? 0 : value;
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

export async function inspectInteractiveRecall(
  input: InspectInteractiveRecallInput
): Promise<InspectInteractiveRecallResult> {
  const store = new FileSessionStore({ cwd: input.cwd, sessionId: input.sessionId, memoryConfig: input.memoryConfig });
  const globalStore = new GlobalMemoryStore({ memoryConfig: input.memoryConfig });

  await store.open();
  await globalStore.open();

  const recalled = await recallInteractiveCandidates({
    store,
    globalStore,
    sessionId: input.sessionId,
    userInput: input.userInput,
    historySummary: input.historySummary,
    latestSummaryText: input.checkpointState?.latestSummaryText,
    recallLimit: Math.max(1, input.recallLimit ?? DEFAULT_RECALL_LIMIT),
    now: input.now,
    debugRecallInputs: input.debugRecallInputs
  });

  return {
    recalled,
    renderedText: renderInteractiveRecallInspection(input.userInput, recalled)
  };
}

function renderInteractiveRecallInspection(query: string, recalled: SessionMemoryCandidate[]): string {
  if (recalled.length === 0) {
    return `Query: ${query}\nNo recalled memories.`;
  }

  return [
    `Query: ${query}`,
    `Matches: ${recalled.length}`,
    ...recalled.map((candidate, index) => `${index + 1}. [${candidate.sessionId === 'user-global' ? 'global' : 'session'}] ${candidate.summaryText} — score=${candidate.retrievalScore.toFixed(2)} importance=${candidate.importance.toFixed(2)}`)
  ].join('\n');
}

async function recallInteractiveCandidates(input: {
  store: FileSessionStore;
  globalStore: GlobalMemoryStore;
  sessionId: string;
  userInput: string;
  historySummary?: string;
  latestSummaryText?: string;
  recallLimit: number;
  now?: string;
  debugRecallInputs?: (record: RecallInputsDebugRecord) => void;
}): Promise<SessionMemoryCandidate[]> {
  const queryEntries = [
    { source: 'userInput' as const, query: input.userInput },
    { source: 'historySummary' as const, query: input.historySummary },
    { source: 'latestSummaryText' as const, query: input.latestSummaryText }
  ].filter((entry): entry is { source: 'userInput' | 'historySummary' | 'latestSummaryText'; query: string } => isPresent(entry.query));
  const queries = queryEntries.map((entry) => entry.query);
  const queryResults: RecallDebugQueryResult[] = [];
  const deduped = new Map<string, SessionMemoryCandidate>();

  for (const entry of queryEntries) {
    const [sessionHits, globalHits] = await Promise.all([
      input.store.recall(entry.query, { k: input.recallLimit }),
      input.globalStore.recall(entry.query, { k: input.recallLimit })
    ]);

    queryResults.push({
      source: entry.source,
      query: entry.query,
      sessionHits: sessionHits.map(toRecallDebugHit),
      globalHits: globalHits.map(toRecallDebugHit)
    });

    for (const candidate of [...sessionHits, ...globalHits]) {
      const dedupeKey = `${normalizeMemoryText(candidate.summaryText)}\n${normalizeMemoryText(candidate.essenceText)}`;
      const existing = deduped.get(dedupeKey);
      if (!existing || scoreMergedCandidate(candidate) > scoreMergedCandidate(existing)) {
        deduped.set(dedupeKey, candidate);
      }
    }
  }

  const finalResults = [...deduped.values()];
  const finalDebugHits = finalResults.map(toRecallDebugHit);
  input.debugRecallInputs?.({
    type: 'memory_recall_inputs',
    timestamp: input.now ?? new Date().toISOString(),
    sessionId: input.sessionId,
    userInput: input.userInput,
    historySummary: input.historySummary,
    latestSummaryText: input.latestSummaryText,
    queries,
    queryCount: queries.length,
    userInputLength: input.userInput.length,
    historySummaryLength: input.historySummary?.length ?? 0,
    latestSummaryTextLength: input.latestSummaryText?.length ?? 0,
    queryOverview: queryResults.map((result) => ({
      source: result.source,
      query: result.query,
      sessionHitCount: result.sessionHits.length,
      globalHitCount: result.globalHits.length,
      totalHitCount: result.sessionHits.length + result.globalHits.length
    })),
    queryResults,
    finalOverview: {
      finalResultCount: finalDebugHits.length,
      sessionFinalCount: finalDebugHits.filter((hit) => hit.sessionId !== 'user-global').length,
      globalFinalCount: finalDebugHits.filter((hit) => hit.sessionId === 'user-global').length
    },
    finalResults: finalDebugHits
  });

  return finalResults;
}

function shouldCaptureGlobalMemory(entry: SessionMemoryEntry): boolean {
  if (containsSensitiveMemoryContent(entry)) {
    return false;
  }

  if (entry.explicitSave) {
    return true;
  }

  if (entry.kind === 'fact'
    || entry.kind === 'heuristic'
    || entry.kind === 'episode'
    || entry.kind === 'decision') {
    return entry.importance >= 0.72;
  }

  if (entry.kind === 'workflow') {
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

function toRecallDebugHit(candidate: SessionMemoryCandidate): RecallDebugHit {
  return {
    hash: candidate.hash,
    sessionId: candidate.sessionId,
    kind: candidate.kind,
    summaryText: candidate.summaryText,
    source: candidate.source,
    retrievalScore: candidate.retrievalScore,
    importance: candidate.importance,
    explicitSave: candidate.explicitSave
  };
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function buildPendingMarkdownPath(directoryPath: string, entry: SessionMemoryEntry): string {
  return `${directoryPath}/${toDateDirectory(entry.createdAt)}/${entry.kind}/${entry.hash}.md`;
}

function toDateDirectory(createdAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/u.test(createdAt) ? createdAt.slice(0, 10) : 'unknown-date';
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
