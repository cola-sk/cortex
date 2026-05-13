# Cortex

一个多智能体 CI 引擎，将 AI 模型编排为可视化流水线，支持并行执行、质量门禁和实时流式输出。

![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)
![React](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61dafb?logo=react)

[English Documentation](README.md)

<p align="center">
  <img src="public/screenshot-pipeline.png" alt="流水线编辑器：plan → implement → review 工作流" width="780">
</p>

## 概述

Cortex 将多个 AI 智能体（Claude、Codex、Gemini、本地模型、自定义 OpenAI 兼容 API）编排为可配置的流水线。每条流水线是一个有向无环图（DAG），任务可串行或并行执行，并支持质量门禁决策点。

**核心能力：**

- **模型中心** — 自动检测本地 CLI 工具（Claude Code、Codex、Gemini、Hermes），连接任意 OpenAI 兼容 API 或自建模型
- **角色智能体** — 定义专业角色（编排者、工作者、审查者、决策者），绑定到模型连接
- **可视化流水线构建器** — 设计包含并行 Worker 和决策检查点的任务图
- **实时执行** — SSE 流式传输任务生命周期和工具调用事件
- **执行历史** — 每次执行完整留存，包含工具调用时间线
- **CLI + Web** — 从终端或浏览器运行流水线

### 界面截图

**模型连接** — 自动检测本地 CLI 工具，管理 API 提供商

<p align="center">
  <img src="public/screenshot-models.png" alt="模型连接页面：已导入的 CLI 工具与 API 提供商" width="780">
</p>

**角色智能体** — 按角色定义智能体（编排者、工作者、审查者、决策者）并配置系统提示词

<p align="center">
  <img src="public/screenshot-agents.png" alt="角色智能体页面：模型绑定关系" width="780">
</p>

## 快速开始

```bash
npm install
npm run dev       # 启动后端 API 服务
npm run web:dev   # 启动 Web 界面（另开终端）
```

打开 http://localhost:47823 访问 Web 界面。

> 首次运行时，Cortex 会自动从内置模板初始化 `agents.yaml` 和 `pipelines.yaml`。

## 架构

```
┌───────────────────────────────────────────────────────────┐
│                     Web UI (React)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐   │
│  │  模型连接  │  │ 角色智能体 │  │  流水线   │  │ 执行记录 │   │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘   │
└──────────────────────┬────────────────────────────────────┘
                       │ REST + SSE
┌──────────────────────▼────────────────────────────────────┐
│                 Express API 服务                           │
│       /api/agents  · /api/pipelines  · /api/runs          │
└──────────────────────┬────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────┐
│                   核心引擎                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │  Agent   │  │ 编排器    │  │  执行器   │                │
│  └──────────┘  └──────────┘  └──────────┘                │
└───────────────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     Claude API  OpenAI 兼容   CLI (claude, codex)
```

## 核心概念

| 概念 | 说明 |
|------|------|
| **模型连接** | 提供商配置 — Claude、OpenAI 兼容 API 或 CLI 工具 |
| **角色智能体** | 专业化角色（编排者 / 工作者 / 审查者 / 决策者），拥有独立系统提示词，通过 `baseAgent` 绑定到模型连接 |
| **流水线** | 任务 DAG。每个任务分配一个或多个智能体，通过 `dependsOn` 声明依赖关系 |
| **质量门禁** | 任务间的质量检查点 — 由决策者智能体审查输出，可触发重试 |
| **执行记录** | 流水线执行的完整快照，包含每个任务的输出和工具调用时间线，以 JSON 持久化 |

## CLI 使用

```bash
# 交互式流水线选择器
cortex run

# 运行指定流水线
cortex run <pipeline-id> "<目标描述>"

# 列出所有流水线
cortex run --list
```

## 流水线配置

流水线定义在 `pipelines.yaml` 中，每个任务指定智能体、输入提示和依赖关系：

```yaml
pipelines:
  code_pipeline:
    name: 代码流水线
    description: '规划 → 并行实现 → 质量门禁审查'
    tasks:
      - id: plan
        name: 规划
        agent: orchestrator
        input: 分析目标并生成详细的实现方案。
        dependsOn: []
      - id: implement
        name: 实现
        agent: [coder, coder2]       # 并行工作者
        input: 按照方案实现解决方案。
        dependsOn: [plan]
      - id: review
        name: 代码审查
        agent: reviewer
        input: 审查所有输出并给出最终结论。
        dependsOn: [implement]
    decisions: []
```

核心特性：
- **并行工作者** — `agent` 为数组时可并行运行多个智能体
- **串行依赖** — `dependsOn` 串联任务顺序
- **质量门禁** — `decisions[]` 添加质量检查点，支持自动重试

完整示例请参阅 [pipelines.example.yaml](pipelines.example.yaml)。

## 智能体配置

智能体定义在 `agents.yaml` 中：

```yaml
# 模型连接
claude-code:
  name: Claude CLI
  provider:
    type: cli
    command: claude

# 角色智能体（绑定到模型）
orchestrator:
  name: 编排者
  role: orchestrator
  system: |
    你是一个技术规划专家。将目标拆解为并行/串行任务...
  baseAgent: claude-code
```

完整模板请参阅 [agents.example.yaml](agents.example.yaml)。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agents` | 列出所有智能体 |
| `POST` | `/api/agents` | 创建智能体 |
| `PUT` | `/api/agents/:id` | 更新智能体 |
| `DELETE` | `/api/agents/:id` | 删除智能体 |
| `GET` | `/api/pipelines` | 列出所有流水线 |
| `POST` | `/api/pipelines` | 创建流水线 |
| `PUT` | `/api/pipelines/:id` | 更新流水线 |
| `POST` | `/api/pipelines/:id/run` | 执行流水线（SSE 流式） |
| `GET` | `/api/runs` | 列出最近的执行记录 |
| `GET` | `/api/runs/:id` | 执行详情（含工具调用时间线） |
| `GET` | `/api/importers` | 检测本地 CLI 工具 |

### SSE 事件

流水线执行时通过 SSE 实时推送事件：

```
task:start         → 任务开始
task:tool_event    → 工具调用事件
task:complete      → 任务完成
decision:start     → 质量门禁触发
decision:complete  → 决策结果（继续 / 重试）
complete           → 流水线执行完毕
error              → 执行错误
```

## 工具调用时间线

CLI 提供商使用 `--output-format stream-json` 可捕获详细的工具调用事件：

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

使用 `text` 格式时，任务输出仍然保留，但不会捕获逐条工具调用详情。

## 项目结构

```
cortex/
├── src/
│   ├── index.ts           # CLI 入口
│   ├── core/              # Agent、编排器、执行器
│   ├── server/            # Express API + SSE
│   └── providers/         # 模型提供商实现
├── web/
│   └── src/               # React SPA (Vite)
├── agents.example.yaml    # 智能体配置模板
├── pipelines.example.yaml # 流水线配置模板
└── runs/                  # 执行历史（已忽略 git）
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动后端 API 服务 |
| `npm run web:dev` | 启动 Web 界面开发服务器 |
| `npm run web` | 构建 Web 并启动生产服务器 |
| `npm run build` | TypeScript 编译 |
| `npm run typecheck` | 类型检查（不生成文件） |
