#!/usr/bin/env python3
"""Summary tool worker.

Reads a JSON payload from stdin and emits a JSON response on stdout.
The implementation stays deterministic and compact while following the
agreed stack: underthesea sentence tokenization, rapidfuzz dedupe,
scikit-learn TF-IDF, and networkx PageRank.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

try:
    from underthesea import sent_tokenize as underthesea_sent_tokenize
except ImportError:  # pragma: no cover - runtime fallback when deps are absent
    underthesea_sent_tokenize = None

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover - runtime fallback when deps are absent
    class _FallbackFuzz:
        @staticmethod
        def ratio(left: str, right: str) -> float:
            return 100.0 if left == right else 0.0

    fuzz = _FallbackFuzz()

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
except ImportError:  # pragma: no cover - runtime fallback when deps are absent
    TfidfVectorizer = None

try:
    import networkx as nx
except ImportError:  # pragma: no cover - runtime fallback when deps are absent
    nx = None

WORD_PATTERN = re.compile(r"\S+")
FALLBACK_SENTENCE_PATTERN = re.compile(r"(?<=[.!?])\s+|\n+")
NORMALIZE_SPACE_PATTERN = re.compile(r"\s+")
VALID_SENTENCE_PATTERN = re.compile(r"\w", re.UNICODE)
DEDUPE_THRESHOLD = 92
MAX_MEMORY_ITEMS = 3

DECISION_KEYWORDS = (
    "decision",
    "decide",
    "decided",
    "ship",
    "approve",
    "approved",
    "choose",
    "chosen",
    "plan",
)
BLOCKER_KEYWORDS = (
    "block",
    "blocked",
    "blocker",
    "await",
    "waiting",
    "risk",
    "pending",
    "stuck",
    "issue",
)
FACT_KEYWORDS = (
    "fact",
    "noted",
    "status",
    "update",
    "customer",
    "team",
    "meeting",
    "progress",
)


class SentenceRecord(dict):
    """Dictionary-like container for sentence metadata.

    Keep the runtime base unparameterized so the worker still runs on Python 3.8,
    which is the project default interpreter in local verification.
    """


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        return emit_error(f"Invalid JSON input: {error}")

    texts = payload.get("texts")
    mode = payload.get("mode", "normal")
    dedupe_sentences = payload.get("dedupe_sentences", True)
    input_truncated = bool(payload.get("input_truncated", False))

    if not isinstance(texts, list) or any(not isinstance(text, str) for text in texts):
        return emit_error("Field 'texts' must be an array of strings.")

    if not isinstance(dedupe_sentences, bool):
        return emit_error("Field 'dedupe_sentences' must be a boolean.")

    normalized_texts = [normalize_text(text) for text in texts if normalize_text(text)]
    sentences = collect_sentences(normalized_texts, dedupe_sentences)

    if not sentences:
        return emit_error("No valid sentences available for summarization.")

    if mode == "memory":
        response = build_memory_response(sentences, input_truncated)
    else:
        response = build_summary_response(sentences, mode, input_truncated)

    json.dump(response, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def build_summary_response(sentences: list[SentenceRecord], mode: Any, input_truncated: bool) -> dict[str, Any]:
    selected = select_summary_sentences(sentences, mode)
    summary = " ".join(record["text"] for record in selected)
    return {
        "summary": summary,
        "input_truncated": input_truncated,
    }


def build_memory_response(sentences: list[SentenceRecord], input_truncated: bool) -> dict[str, Any]:
    if len(sentences) == 1:
        only_sentence = sentences[0]["text"]
        return {
            "facts": [only_sentence],
            "decisions": [],
            "blockers": [],
            "input_truncated": input_truncated,
        }

    ranked = rank_sentences(sentences)
    ordered = sorted(ranked, key=lambda record: (record["rank"], -record["index"]), reverse=True)

    facts = take_bucket(ordered, FACT_KEYWORDS, fallback=True)
    decisions = take_bucket(ordered, DECISION_KEYWORDS)
    blockers = take_bucket(ordered, BLOCKER_KEYWORDS)

    if not facts:
        facts = [ordered[0]["text"]]

    return {
        "facts": facts,
        "decisions": decisions,
        "blockers": blockers,
        "input_truncated": input_truncated,
    }


def collect_sentences(texts: list[str], should_dedupe: bool) -> list[SentenceRecord]:
    records: list[SentenceRecord] = []
    sentence_index = 0

    for source_index, text in enumerate(texts):
        for sentence in tokenize_sentences(text):
            normalized_sentence = normalize_text(sentence)
            if not normalized_sentence or not VALID_SENTENCE_PATTERN.search(normalized_sentence):
                continue
            records.append(
                SentenceRecord(
                    text=normalized_sentence,
                    normalized=normalized_sentence.casefold(),
                    index=sentence_index,
                    source_index=source_index,
                )
            )
            sentence_index += 1

    if not should_dedupe:
        return records

    return dedupe_sentences(records)


def tokenize_sentences(text: str) -> list[str]:
    if underthesea_sent_tokenize is not None:
        parts = [normalize_text(part) for part in underthesea_sent_tokenize(text)]
        valid_parts = [part for part in parts if part]
        if valid_parts:
            return valid_parts

    parts = [normalize_text(segment) for segment in FALLBACK_SENTENCE_PATTERN.split(text)]
    return [part for part in parts if part]


def dedupe_sentences(sentences: list[SentenceRecord]) -> list[SentenceRecord]:
    unique_sentences: list[SentenceRecord] = []
    for sentence in sentences:
        if any(fuzz.ratio(sentence["normalized"], existing["normalized"]) >= DEDUPE_THRESHOLD for existing in unique_sentences):
            continue
        unique_sentences.append(sentence)
    return unique_sentences


def select_summary_sentences(sentences: list[SentenceRecord], mode: Any) -> list[SentenceRecord]:
    count = len(sentences)
    if count == 1:
        return sentences[:1]

    if count <= 3:
        limit = 1 if mode == "concise" else count
        return sentences[:limit]

    target = 2 if mode == "concise" else 3
    ranked = rank_sentences(sentences)
    top_ranked = sorted(ranked, key=lambda record: (record["rank"], -record["index"]), reverse=True)[:target]
    return sorted(top_ranked, key=lambda record: record["index"])


def rank_sentences(sentences: list[SentenceRecord]) -> list[SentenceRecord]:
    if len(sentences) <= 1:
        sentence = sentences[0]
        sentence["rank"] = 1.0
        return sentences

    similarity_graph = build_similarity_graph(sentences)
    if similarity_graph is None or similarity_graph.number_of_edges() == 0:
        for sentence in sentences:
            sentence["rank"] = 1.0 / max(len(sentences), 1)
        return sentences

    scores = nx.pagerank(similarity_graph, weight="weight")
    for sentence in sentences:
        sentence["rank"] = float(scores.get(sentence["index"], 0.0))
    return sentences


def build_similarity_graph(sentences: list[SentenceRecord]):
    if TfidfVectorizer is None or nx is None:
        return None

    try:
        matrix = TfidfVectorizer().fit_transform([sentence["text"] for sentence in sentences])
        similarity_matrix = (matrix * matrix.T).toarray()
    except ValueError:
        return None

    graph = nx.Graph()
    for sentence in sentences:
        graph.add_node(sentence["index"])

    for left_index, left_sentence in enumerate(sentences):
        for right_index in range(left_index + 1, len(sentences)):
            score = float(similarity_matrix[left_index][right_index])
            if score > 0.0:
                graph.add_edge(left_sentence["index"], sentences[right_index]["index"], weight=score)

    return graph


def take_bucket(sentences: list[SentenceRecord], keywords: tuple[str, ...], fallback: bool = False) -> list[str]:
    matches = [sentence for sentence in sentences if contains_keyword(sentence["text"], keywords)]
    selected = matches[:MAX_MEMORY_ITEMS]

    if fallback and not selected:
        selected = sentences[:1]

    ordered = sorted(selected, key=lambda sentence: sentence["index"])
    return [sentence["text"] for sentence in ordered]


def normalize_text(text: str) -> str:
    return NORMALIZE_SPACE_PATTERN.sub(" ", text.replace("\r", " ").replace("\n", " ")).strip()


def truncate_words(text: str, max_words: int) -> str:
    words = WORD_PATTERN.findall(text)
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).strip() + "…"


def contains_keyword(text: str, keywords: tuple[str, ...]) -> bool:
    normalized = text.casefold()
    return any(keyword in normalized for keyword in keywords)


def emit_error(message: str) -> int:
    sys.stderr.write(message + "\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
