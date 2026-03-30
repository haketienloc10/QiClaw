# QiClaw

CLI TypeScript tối giản với 2 chế độ: chạy một prompt hoặc interactive REPL.

## Cài đặt

Cần Node.js.

```bash
npm install
```

## Chạy

### Interactive

```bash
npm run dev
```

Thoát REPL bằng:

```text
exit
/exit
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
npm test
npm run typecheck:test
```

- `npm run dev`: chạy CLI từ [src/cli/main.ts](src/cli/main.ts)
- `npm run build`: build TypeScript ra `dist`
- `npm test`: chạy Vitest
- `npm run typecheck:test`: type-check test

### CLI options

- `--prompt <text>`: chạy một prompt rồi thoát
- `--model <name>`: chọn model runtime
- `exit` hoặc `/exit`: thoát REPL
