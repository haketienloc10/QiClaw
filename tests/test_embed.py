import json
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434/api/embeddings"
MODEL = "bge-m3"

retrieval_text = """Heading: Khi cần ngày hoặc giờ hiện tại, phải chạy lệnh trên máy để lấy thời gian chính xác thay vì suy đoán từ ngữ cảnh
Title: Dùng lệnh trên máy để lấy ngày giờ hiện tại khi user hỏi thời gian
Summary: Khi cần ngày hoặc giờ hiện tại, phải chạy lệnh trên máy để lấy thời gian chính xác thay vì suy đoán từ ngữ cảnh
Kind: workflow
Tags: time, datetime, shell, workflow, realtime
Content: Khi cần ngày hoặc giờ hiện tại, phải chạy lệnh trên máy để lấy thời gian chính xác thay vì suy đoán từ ngữ cảnh
"""

queries = [
    "Bây giờ là mấy giờ?",
    "Hôm nay ngày bao nhiêu?",
    "Lấy thời gian hiện tại kiểu gì?",
    "Hôm nay là thứ mấy?",
    "Ai quyết định dùng PostgreSQL?"
]

def embed(text: str):
    payload = {
        "model": MODEL,
        "prompt": text
    }
    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        OLLAMA_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        return body["embedding"]

def cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

def main():
    total_start = time.perf_counter()

    t0 = time.perf_counter()
    memory_vec = embed(retrieval_text)
    t1 = time.perf_counter()

    print(f"[memory] embed_time={t1 - t0:.4f}s dim={len(memory_vec)}")
    print("-" * 80)

    for query in queries:
        q_start = time.perf_counter()

        t_embed_start = time.perf_counter()
        query_vec = embed(query)
        t_embed_end = time.perf_counter()

        t_sim_start = time.perf_counter()
        score = cosine_similarity(memory_vec, query_vec)
        t_sim_end = time.perf_counter()

        q_end = time.perf_counter()

        print(f"query: {query}")
        print(f"  score            = {score:.6f}")
        print(f"  query_embed_time = {t_embed_end - t_embed_start:.4f}s")
        print(f"  similarity_time  = {t_sim_end - t_sim_start:.6f}s")
        print(f"  total_query_time = {q_end - q_start:.4f}s")
        print()

    total_end = time.perf_counter()
    print("-" * 80)
    print(f"TOTAL ELAPSED TIME = {total_end - total_start:.4f}s")

if __name__ == "__main__":
    main()