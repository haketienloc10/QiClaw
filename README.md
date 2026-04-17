# QiClaw

CLI TypeScript tối giản với 2 chế độ: chạy một prompt hoặc interactive REPL.

## Cài đặt

Cần Node.js.

```bash
npm install
```

## Chạy

### Interactive

Mặc định `npm run dev` chạy CLI/plain REPL.

```bash
npm run dev
```

TUI chỉ được bật khi đặt `QICLAW_TUI_ENABLED=true` và đang chạy trong interactive TTY. Ví dụ:

```bash
QICLAW_TUI_ENABLED=true npm run dev
```

Nếu cần build binary TUI trước:

```bash
npm run build:tui
```

TUI dùng terminal trực tiếp qua stdio inherit và bridge NDJSON trên fd 3/4. Bridge này hiện yêu cầu hệ Unix-like; trên môi trường không hỗ trợ interactive TUI sẽ tự fallback về plain CLI path.

Thoát REPL/TUI bằng:

```text
exit
/exit
Ctrl+C
```

### One-shot

```bash
npm run dev -- --prompt "Hello"
```

Chọn model:

```bash
npm run dev -- --model claude-sonnet-4-20250514 --prompt "Summarize this codebase"
```

## Command

### NPM scripts

```bash
npm run dev
npm run build
npm run build:tui
npm test
npm run test:tui
npm run typecheck:test
```

- `npm run dev`: chạy CLI từ [src/cli/main.ts](src/cli/main.ts)
- `npm run build`: build TypeScript ra `dist`
- `npm run build:tui`: build Rust TUI binary tại `tui/target/debug/qiclaw-tui`
- `npm test`: chạy Vitest
- `npm run test:tui`: chạy unit test cho Rust TUI
- `npm run typecheck:test`: type-check test

### CLI options

- `--prompt <text>`: chạy một prompt rồi thoát
- `--model <name>`: chọn model runtime
- `exit` hoặc `/exit`: thoát REPL
