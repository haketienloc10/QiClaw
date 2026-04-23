#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import textwrap
from pathlib import Path

HISTORY = [
    {
        "role": "user",
        "content": "Hãy giải thích vì sao memoryText lại có role user trong prompt cuối cùng."
    },
    {
        "role": "assistant",
        "content": "Tôi sẽ đọc promptBuilder.ts và sessionMemoryEngine.ts để trả lời theo source code."
    },
    {
        "role": "assistant",
        "content": "I am making a tool call to inspect promptBuilder.ts.",
        "toolCalls": [
            {
                "id": "call_prompt_builder",
                "name": "Read",
                "input": {
                    "file_path": "/home/locdt/QiClaw/src/context/promptBuilder.ts"
                }
            }
        ]
    },
    {
        "role": "tool",
        "name": "Read",
        "toolCallId": "call_prompt_builder",
        "content": "19\texport function buildPromptWithContext(input: BuildPromptWithContextInput): PromptWithContext {\n20\t  const parts = [\n21\t    input.baseSystemPrompt,\n22\t    input.includeSkills === false ? undefined : input.skillsText,\n23\t    input.includeHistorySummary === false ? undefined : input.historySummary\n24\t  ].filter(isPresent);\n25\t  const systemPrompt = parts.join('\\n\\n');\n26\t  const memoryMessage = input.includeMemory === false || !isPresent(input.memoryText)\n27\t    ? []\n28\t    : [{ role: 'user', content: input.memoryText } satisfies Message];\n29\t\n30\t  return {\n31\t    systemPrompt,\n32\t    messages: [{ role: 'system', content: systemPrompt }, ...memoryMessage, ...input.history]\n33\t  };\n34\t}"
    },
    {
        "role": "assistant",
        "content": "Đoạn này cho thấy memoryText được chèn thành một user message, rồi mới nối tiếp history."
    },
    {
        "role": "assistant",
        "content": "I am making a tool call to inspect sessionMemoryEngine.ts for memory rendering.",
        "toolCalls": [
            {
                "id": "call_memory_engine",
                "name": "Read",
                "input": {
                    "file_path": "/home/locdt/QiClaw/src/memory/sessionMemoryEngine.ts"
                }
            }
        ]
    },
    {
        "role": "tool",
        "name": "Read",
        "toolCallId": "call_memory_engine",
        "content": "489\tconst sections = ['Memory:'];\n491\tif (hot.length > 0) {\n492\t  sections.push('Hot memories:', ...hot);\n493\t}\n495\tif (warm.length > 0) {\n496\t  sections.push('Warm summaries:', ...warm);\n497\t}\n499\tif (faded.length > 0) {\n500\t  sections.push('Faded references:', ...faded);\n501\t}\n503\treturn sections.join('\\n');"
    },
    {
        "role": "assistant",
        "content": "Đoạn này cho thấy các section Hot memories, Warm summaries, Faded references được tạo lúc render memoryText, không phải lấy nguyên từ index.json."
    },
    {
        "role": "user",
        "content": "Vậy fullText, summaryText, essenceText được dùng ở bước nào?"
    },
    {
        "role": "assistant",
        "content": "Chúng được chọn theo fidelity: full, summary, essence, hoặc hash, rồi mới được render thành từng dòng trong memoryText."
    },
    {
        "role": "user",
        "content": "Hãy cho tôi một ví dụ history đủ thật để tôi test compactHistoryMessages."
    }
]


def build_ts_program(payload_json: str, cwd: str) -> str:
    return textwrap.dedent(
        f"""
        import {{ summaryTool }} from {json.dumps(str(Path(cwd) / 'dist' / 'tools' / 'summary.js'))};

        async function main() {{
          const input = {payload_json};
          const result = await summaryTool.execute(input, {{ cwd: {json.dumps(cwd)} }});
          process.stdout.write(JSON.stringify(result, null, 2));
          process.stdout.write('\\n');
        }}

        main().catch((error) => {{
          console.error(error);
          process.exit(1);
        }});
        """
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run QiClaw summary_tool against a fixed transcript.")
    parser.add_argument("--mode", choices=["normal", "concise", "memory"], default="normal")
    parser.add_argument("--dedupe-sentences", dest="dedupe_sentences", action="store_true", default=True)
    parser.add_argument("--no-dedupe-sentences", dest="dedupe_sentences", action="store_false")
    parser.add_argument("--json-only", action="store_true", help="Only print tool JSON output.")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent
    payload = {
        "messages": HISTORY,
        "mode": args.mode,
        "dedupeSentences": args.dedupe_sentences,
    }

    program = build_ts_program(json.dumps(payload, ensure_ascii=False), str(repo_root))
    command = ["node", "--input-type=module", "--eval", program]
    completed = subprocess.run(command, cwd=repo_root, text=True, capture_output=True)

    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        return completed.returncode

    if args.json_only:
        sys.stdout.write(completed.stdout)
        return 0

    result = json.loads(completed.stdout)
    print(f"mode={args.mode} dedupeSentences={args.dedupe_sentences}")
    print("-" * 60)
    print(result.get("content", ""))
    print("-" * 60)
    print(json.dumps(result.get("data", {}), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
