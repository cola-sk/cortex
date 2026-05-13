# Cortex

Cortex is a multi-agent orchestration project with:
- Node.js/TypeScript backend
- React + Vite web UI
- CLI pipeline runner

## Quick Start

```bash
npm install
npm run server
npm run web:dev
```

Default endpoints:
- API: http://localhost:47821
- UI: http://localhost:47823 (dev)

## Core Concepts

- Model Connection: provider config (OpenAI-compatible, Claude, CLI)
- Role Agent: task role with system prompt, usually references a model connection via `baseAgent`
- Pipeline: task graph + optional decision checkpoints

## Recent Updates

### 1) Role Agent list shows model name

In the web UI Roles page, each role agent now shows the connected model label using:
- model connection `name` first
- fallback to `id` when no name exists
- display format: `Name (#id)` when both are available

### 2) Run history persistence for both Web and CLI runs

Pipeline executions are persisted to `runs/<run-id>.json` in both paths:
- Web API execution
- CLI execution (`cortex run ...`)

This means Runs page can display execution records regardless of whether the run was started from web or terminal.

### 3) Tool call timeline support

Run records include per-task tool events when CLI model output is machine-readable.

For Claude CLI provider, use stream JSON output for tool events:

```yaml
provider:
  type: cli
  command: claude
  args:
    - --system-prompt
    - '{{SYSTEM}}'
    - -p
    - '{{PROMPT}}'
    - --output-format
    - stream-json
```

If `--output-format text` is used, task output still persists, but tool call details are not captured.

## Build & Type Check

```bash
npm run build
cd web && npx tsc --noEmit
```

## Notes

- Run files are stored under `runs/`.
- You can override run directory with `RUNS_DIR` environment variable.
