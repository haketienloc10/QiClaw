# Summary Tool Transcript Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở rộng `summary_tool` để nhận transcript qua field `messages`, đồng thời chuyển tool này thành private/internal tool không gửi sang LLM.

**Architecture:** Giữ nguyên Python worker và toàn bộ thuật toán summarize hiện có. Thêm bước normalize input trong TypeScript để chuyển `messages` thành `texts` bằng cách chỉ lấy `message.content`, sau đó tái sử dụng pipeline validation, input limit, worker invocation, và result rendering hiện tại. Đồng thời bỏ `summary_tool` khỏi runtime tool surface để LLM không còn thấy hoặc gọi được nó.

**Tech Stack:** TypeScript, Vitest, Node.js, Python worker wrapper, existing tool registry/runtime

---

## File Structure

- Modify: `src/tools/summary.ts`
  - Mở rộng input schema để hỗ trợ `messages`
  - Thêm kiểu `MessageLike` tối thiểu cho transcript input
  - Thêm bước normalize từ `messages` -> `texts`
  - Giữ nguyên worker payload và output renderer hiện có
- Modify: `src/agent/runtime.ts`
  - Bỏ `summary_tool` khỏi capability class `read` để runtime không expose tool này cho LLM
- Modify: `tests/tools/summary.test.ts`
  - Bổ sung validation và execution tests cho `messages`
  - Bổ sung tests cho lỗi input khi thiếu cả `texts` lẫn `messages`
  - Bổ sung tests chứng minh tool chỉ summarize từ `content`, bỏ qua `toolCalls`
- Modify: `tests/agent/runtime.test.ts`
  - Cập nhật expected runtime tool surface sau khi `summary_tool` thành private
- Modify: `tests/tools/toolSurfaceMigration.test.ts`
  - Cập nhật expected builtin/runtime tool surface sau thay đổi visibility
- Optional check only: `src/tools/registry.ts`
  - Không đổi nếu internal code vẫn cần import/register tool; chỉ xác nhận hành vi hiện tại vẫn hợp lý

---

### Task 1: Thêm test thất bại cho transcript input trong summary tool

**Files:**
- Modify: `tests/tools/summary.test.ts`
- Test: `tests/tools/summary.test.ts`

- [ ] **Step 1: Viết test validate input `messages` hợp lệ**

```ts
  it('accepts transcript-style messages input via validateToolInput', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca();

    expect(() =>
      validateToolInput(summaryTool, {
        messages: [
          { role: 'user', content: 'Giải thích prompt builder.' },
          { role: 'assistant', content: 'Tôi sẽ đọc source code.' }
        ],
        mode: 'normal',
        dedupeSentences: true
      })
    ).not.toThrow();
  });
```

- [ ] **Step 2: Viết test execute dùng `messages` và chỉ gửi `content` sang worker**

```ts
  it('normalizes messages to text blocks using content only before invoking the worker', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({
        summary: 'Transcript summary',
        input_truncated: false
      })
    }));

    await summaryTool.execute(
      {
        messages: [
          {
            role: 'assistant',
            content: 'I am making a tool call.',
            toolCalls: [{ id: 'call_1', name: 'Read', input: { file_path: '/tmp/a.ts' } }]
          },
          {
            role: 'tool',
            name: 'Read',
            toolCallId: 'call_1',
            content: 'const answer = 42;'
          }
        ],
        mode: 'normal',
        dedupeSentences: true
      } as never,
      { cwd: process.cwd() }
    );

    const workerPayload = JSON.parse(String(execaMock.mock.calls[0]?.[2]?.input ?? ''));
    expect(workerPayload).toMatchObject({
      texts: ['I am making a tool call.', 'const answer = 42;']
    });
  });
```

- [ ] **Step 3: Viết test lỗi khi thiếu cả `texts` lẫn `messages`**

```ts
  it('rejects when neither texts nor messages are provided', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          mode: 'normal',
          dedupeSentences: true
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);

    expect(execaMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Viết test lỗi khi `messages` chỉ chứa content rỗng**

```ts
  it('rejects when messages produce no non-empty content blocks', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          messages: [
            { role: 'user', content: '   ' },
            { role: 'assistant', content: '' }
          ],
          mode: 'normal',
          dedupeSentences: true
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);

    expect(execaMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 5: Chạy test summary tool để xác nhận các test mới đang fail**

Run: `npm run test -- tests/tools/summary.test.ts`
Expected: FAIL với lỗi schema/validation vì `messages` chưa được hỗ trợ.

- [ ] **Step 6: Commit**

```bash
git add tests/tools/summary.test.ts
git commit -m "test: cover transcript input for summary tool"
```

---

### Task 2: Mở rộng summary tool để nhận `messages`

**Files:**
- Modify: `src/tools/summary.ts:8-140`
- Test: `tests/tools/summary.test.ts`

- [ ] **Step 1: Khai báo kiểu transcript input tối thiểu**

```ts
type MessageLike = {
  role: string;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input?: unknown;
  }>;
};

type SummaryToolInput = {
  texts?: string[];
  messages?: MessageLike[];
  mode?: string;
  dedupeSentences?: boolean;
};
```

- [ ] **Step 2: Mở rộng input schema để cho phép `messages`**

```ts
  inputSchema: {
    type: 'object',
    properties: {
      texts: {
        type: 'array',
        items: { type: 'string' }
      },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            content: { type: 'string' },
            name: { type: 'string' },
            toolCallId: { type: 'string' },
            toolCalls: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  input: {}
                },
                required: ['id', 'name'],
                additionalProperties: true
              }
            }
          },
          required: ['role', 'content'],
          additionalProperties: true
        }
      },
      mode: { type: 'string' },
      dedupeSentences: { type: 'boolean' }
    },
    additionalProperties: false
  },
```

- [ ] **Step 3: Thêm hàm normalize từ `messages` sang `texts`**

```ts
function normalizeTranscriptMessages(messages: MessageLike[]): string[] {
  return messages
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0);
}
```

- [ ] **Step 4: Cập nhật `normalizeAndValidateInput` để hỗ trợ hai nguồn input**

```ts
function normalizeAndValidateInput(input: SummaryToolInput): {
  texts: string[];
  mode: SummaryMode;
  dedupeSentences: boolean;
} {
  const textsFromInput = Array.isArray(input.texts) ? input.texts : undefined;
  const textsFromMessages = Array.isArray(input.messages)
    ? normalizeTranscriptMessages(input.messages)
    : undefined;

  const texts = textsFromInput ?? textsFromMessages;
  if (!texts || texts.length === 0) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: provide non-empty texts or messages.');
  }

  if (texts.length > MAX_BLOCKS) {
    throw new Error(`SUMMARY_TOOL_INVALID_INPUT: texts must contain no more than ${MAX_BLOCKS} blocks.`);
  }

  if (texts.some((text) => typeof text !== 'string')) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: texts must contain only strings.');
  }

  if (texts.some((text) => text.trim().length === 0)) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: text blocks must be non-empty after trimming.');
  }

  const mode = (input.mode ?? 'normal') as SummaryMode;
  if (!isSummaryMode(mode)) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: unsupported mode.');
  }

  const dedupeSentences = input.dedupeSentences ?? true;
  if (typeof dedupeSentences !== 'boolean') {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: dedupeSentences must be a boolean.');
  }

  return { texts, mode, dedupeSentences };
}
```

- [ ] **Step 5: Giữ nguyên phần còn lại của execute pipeline**

```ts
    const normalizedInput = normalizeAndValidateInput(input);
    const limitedInput = applyInputLimits(normalizedInput.texts);
    const payload = {
      texts: limitedInput.texts,
      mode: normalizedInput.mode,
      dedupe_sentences: normalizedInput.dedupeSentences,
      input_truncated: limitedInput.inputTruncated
    };
```

- [ ] **Step 6: Chạy test summary tool để xác nhận pass**

Run: `npm run test -- tests/tools/summary.test.ts`
Expected: PASS, bao gồm các case `texts` cũ và `messages` mới.

- [ ] **Step 7: Commit**

```bash
git add src/tools/summary.ts tests/tools/summary.test.ts
git commit -m "feat: support transcript messages in summary tool"
```

---

### Task 3: Chuyển summary tool thành private runtime tool

**Files:**
- Modify: `src/agent/runtime.ts:1-40`
- Modify: `tests/agent/runtime.test.ts`
- Modify: `tests/tools/toolSurfaceMigration.test.ts`
- Test: `tests/agent/runtime.test.ts`
- Test: `tests/tools/toolSurfaceMigration.test.ts`

- [ ] **Step 1: Viết test thất bại cho runtime tool surface mới**

```ts
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
```

Áp dụng thay cho các assertion hiện đang mong đợi có `summary_tool` trong:
- `tests/agent/runtime.test.ts`
- `tests/tools/toolSurfaceMigration.test.ts`

- [ ] **Step 2: Chạy riêng test runtime/tool surface để xác nhận đang fail**

Run: `npm run test -- tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts`
Expected: FAIL vì runtime hiện vẫn expose `summary_tool`.

- [ ] **Step 3: Bỏ `summary_tool` khỏi runtime capability list**

```ts
const builtinToolClasses = {
  read: ['file', 'shell', 'git', 'web_fetch'],
  write: ['file', 'shell', 'git'],
  search: ['file', 'shell', 'git', 'web_fetch']
} as const;
```

- [ ] **Step 4: Giữ `summaryTool` trong registry để code nội bộ/tests vẫn import được**

```ts
const builtinTools = [fileTool, shellTool, gitTool, webFetchTool, summaryTool] as const;
```

Không sửa registry ở bước này; chỉ xác nhận rằng private ở đây nghĩa là **không có trong runtime.availableTools** và không có trong request gửi sang model.

- [ ] **Step 5: Chạy test runtime/tool surface để xác nhận pass**

Run: `npm run test -- tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts`
Expected: PASS với runtime chỉ còn `file`, `shell`, `git`, `web_fetch`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/runtime.ts tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts
git commit -m "refactor: keep summary tool private to runtime"
```

---

### Task 4: Cập nhật các test integration quanh loop/runtime có tool list cố định

**Files:**
- Modify: `tests/agent/loop.test.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Thay mọi expected tool list có `summary_tool` bằng tool surface mới**

Thay các assertion dạng:

```ts
expect(getBuiltinToolNames()).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
expect(request.tools?.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
```

thành:

```ts
expect(getBuiltinToolNames()).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
expect(request.tools?.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
```

Lưu ý: `registry` vẫn có `summary_tool`, nên chỉ sửa expectation về **runtime/request tools**, không sửa expectation về registry nếu test đang kiểm tra registry.

- [ ] **Step 2: Chạy test loop để xác nhận các assertion cũ fail/pass đúng chỗ**

Run: `npm run test -- tests/agent/loop.test.ts`
Expected: Nếu còn sót assertion cũ liên quan `summary_tool` trong runtime/request surface, test sẽ FAIL đúng tại các vị trí đó.

- [ ] **Step 3: Hoàn tất cập nhật cho toàn bộ expectation liên quan runtime/request tools**

Ví dụ các object fixture cần sửa:

```ts
availableToolNames: ['file', 'shell', 'git', 'web_fetch']
toolNames: ['file', 'shell', 'git', 'web_fetch']
```

- [ ] **Step 4: Chạy lại test loop để xác nhận pass**

Run: `npm run test -- tests/agent/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agent/loop.test.ts
git commit -m "test: update runtime tool surface expectations"
```

---

### Task 5: Chạy verification cuối cùng

**Files:**
- Modify: `src/tools/summary.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `tests/tools/summary.test.ts`
- Modify: `tests/agent/runtime.test.ts`
- Modify: `tests/tools/toolSurfaceMigration.test.ts`
- Modify: `tests/agent/loop.test.ts`

- [ ] **Step 1: Chạy typecheck cho test code**

Run: `npm run typecheck:test`
Expected: PASS.

- [ ] **Step 2: Chạy nhóm test trực tiếp bị ảnh hưởng**

Run: `npm run test -- tests/tools/summary.test.ts tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts tests/agent/loop.test.ts`
Expected: PASS.

- [ ] **Step 3: Chạy full test suite nếu nhóm test trên pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Xem diff cuối trước khi kết luận**

Run: `git diff -- src/tools/summary.ts src/agent/runtime.ts tests/tools/summary.test.ts tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts tests/agent/loop.test.ts`
Expected: Chỉ có thay đổi phục vụ transcript support và private runtime visibility cho `summary_tool`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/summary.ts src/agent/runtime.ts tests/tools/summary.test.ts tests/agent/runtime.test.ts tests/tools/toolSurfaceMigration.test.ts tests/agent/loop.test.ts
git commit -m "feat: add transcript support to summary tool"
```

---

## Self-Review

- Spec coverage: plan đã bao phủ cả hai yêu cầu đã chốt — hỗ trợ `messages` và không expose `summary_tool` cho LLM.
- Placeholder scan: không dùng TBD/TODO; mọi task có file path, code mẫu, lệnh chạy, và expected output.
- Type consistency: dùng nhất quán `messages`, `MessageLike`, `content`, `runtime.availableTools`, và giữ `texts` là normalized output cho worker.
