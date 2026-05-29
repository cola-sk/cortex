import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Agent, RunSummary, RunRecord, RunTaskRecord, RunEventType, ToolEvent, Pipeline, ReviewRecord, RoundRecord } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { TaskDetailShared, MarkdownWithThinking, type DetailStatus, formatAgentInfo, getBaseAgentId } from './TaskDetailShared';
import {
  ReactFlow,
  Background,
  Controls,
  BezierEdge,
  MiniMap,
  MarkerType,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusColors(status: string, error?: string) {
  if (error === 'Skipped due to previous task failure') return 'bg-zinc-100 text-zinc-500';
  if (status === 'done') return 'bg-emerald-100 text-emerald-700';
  if (status === 'terminated') return 'bg-zinc-200 text-zinc-700';
  if (status === 'error') return 'bg-red-100 text-red-600';
  if (status === 'skipped') return 'bg-zinc-100 text-zinc-500';
  if (status === 'awaiting_review') return 'bg-amber-100 text-amber-700';
  if (status === 'interrupted') return 'bg-zinc-100 text-zinc-700';
  return 'bg-blue-100 text-blue-600';
}

function statusDot(status: string, error?: string) {
  if (error === 'Skipped due to previous task failure') return 'bg-zinc-300';
  if (status === 'done') return 'bg-emerald-400';
  if (status === 'terminated') return 'bg-zinc-500';
  if (status === 'error') return 'bg-red-400';
  if (status === 'skipped') return 'bg-zinc-300';
  if (status === 'awaiting_review') return 'bg-amber-400 animate-pulse';
  if (status === 'interrupted') return 'bg-zinc-400';
  return 'bg-blue-400 animate-pulse';
}

function statusLabel(status: RunSummary['status'] | RunTaskRecord['status'], error?: string): string {
  if (error === 'Skipped due to previous task failure') return 'skipped';
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'terminated') return 'terminated';
  if (status === 'error') return 'error';
  if (status === 'skipped') return 'skipped';
  if (status === 'awaiting_review') return 'awaiting_input';
  if (status === 'interrupted') return 'interrupted';
  return status;
}

function isTerminationNoopMessage(message?: string): boolean {
  if (!message) return false;
  return message.includes('No pending review for run')
    || message.includes('is not currently active or cannot be terminated')
    || message.includes('Run already finished');
}

function readRunsHashParams(): { runId: string | null; taskId: string | null } {
  const hash = window.location.hash.replace('#', '');
  const [page, query = ''] = hash.split('?');
  if (page !== 'runs') return { runId: null, taskId: null };
  const params = new URLSearchParams(query);
  return {
    runId: params.get('runId'),
    taskId: params.get('taskId'),
  };
}

function getRootRunId(runId: string | null, allRuns: RunSummary[]): string | null {
  if (!runId) return null;
  const runMap = new Map(allRuns.map(r => [r.id, r]));
  let currentId = runId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const current = runMap.get(currentId);
    if (current && current.continuedFromRunId) {
      currentId = current.continuedFromRunId;
    } else {
      break;
    }
  }
  return currentId;
}

function getLineageChain(currentRun: RunSummary | RunRecord | null, allRuns: RunSummary[]): RunSummary[] {
  if (!currentRun) return [];

  // 1. Create a combined list of all runs + current run to prevent race condition timing issues
  const combinedRunsMap = new Map<string, RunSummary>();
  allRuns.forEach(r => combinedRunsMap.set(r.id, r));

  const currentSummary: RunSummary = {
    id: currentRun.id,
    pipelineId: currentRun.pipelineId,
    pipelineName: currentRun.pipelineName,
    goal: currentRun.goal,
    status: currentRun.status,
    startedAt: currentRun.startedAt,
    finishedAt: currentRun.finishedAt,
    durationMs: currentRun.durationMs,
    taskCount: currentRun.taskCount,
    toolCallCount: currentRun.toolCallCount,
    continuedFromRunId: currentRun.continuedFromRunId,
    continuationTaskId: (currentRun as any).continuationTaskId,
    continuationTaskName: (currentRun as any).continuationTaskName,
    continuationType: (currentRun as any).continuationType,
    continuationRound: (currentRun as any).continuationRound,
  };
  combinedRunsMap.set(currentRun.id, currentSummary);

  const combinedRuns = Array.from(combinedRunsMap.values());

  // Helper to trace the absolute root run ID upwards for any run
  const findAbsoluteRootId = (runId: string) => {
    let currentId = runId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const current = combinedRunsMap.get(currentId);
      if (current && current.continuedFromRunId) {
        currentId = current.continuedFromRunId;
      } else {
        break;
      }
    }
    return currentId;
  };

  // Find the absolute root ID of our current run
  const targetRootId = findAbsoluteRootId(currentRun.id);

  // 2. Filter out all runs that share this same absolute root ID
  const chain = combinedRuns.filter(r => findAbsoluteRootId(r.id) === targetRootId);

  // 3. Sort chronologically
  chain.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  return chain;
}

type GroupedRunItem =
  | { type: 'group'; pipelineId: string; pipelineName: string; runCount: number; isCollapsed: boolean }
  | { type: 'run'; run: RunSummary; depth: number; hasChild: boolean; collapsed: boolean };

function buildGroupedRunList(
  runs: RunSummary[],
  collapsedPipelines: Set<string>,
  collapsedRuns: Set<string>,
): GroupedRunItem[] {
  const pipelineGroups = new Map<string, { pipelineName: string; runs: RunSummary[] }>();
  runs.forEach(r => {
    const group = pipelineGroups.get(r.pipelineId) || { pipelineName: r.pipelineName, runs: [] };
    group.runs.push(r);
    pipelineGroups.set(r.pipelineId, group);
  });

  const sortedPipelines = Array.from(pipelineGroups.entries()).sort((a, b) => {
    const firstA = Math.min(...a[1].runs.map(r => new Date(r.startedAt).getTime()));
    const firstB = Math.min(...b[1].runs.map(r => new Date(r.startedAt).getTime()));
    return firstA - firstB;
  });

  const result: GroupedRunItem[] = [];

  for (const [pipelineId, { pipelineName, runs: pRuns }] of sortedPipelines) {
    const isCollapsed = collapsedPipelines.has(pipelineId);
    result.push({ type: 'group', pipelineId, pipelineName, runCount: pRuns.length, isCollapsed });
    if (isCollapsed) continue;

    const pRunMap = new Map<string, RunSummary>();
    pRuns.forEach(r => pRunMap.set(r.id, r));

    // Only 'continue' (重跑) runs nest under their direct parent.
    // 'branch' runs break the chain and appear at depth 0.
    const continueChildrenMap = new Map<string, RunSummary[]>();
    pRuns.forEach(r => {
      if (r.continuedFromRunId && pRunMap.has(r.continuedFromRunId) && r.continuationType === 'continue') {
        const list = continueChildrenMap.get(r.continuedFromRunId) || [];
        list.push(r);
        continueChildrenMap.set(r.continuedFromRunId, list);
      }
    });
    continueChildrenMap.forEach(list =>
      list.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    );

    // Root runs: everything that is NOT a 'continue' child of another run in this pipeline
    const rootRuns = pRuns.filter(r =>
      !r.continuedFromRunId ||
      !pRunMap.has(r.continuedFromRunId) ||
      r.continuationType !== 'continue'
    );
    rootRuns.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

    function traverse(run: RunSummary, depth: number, parentCollapsed: boolean) {
      if (parentCollapsed) return;
      const children = continueChildrenMap.get(run.id) || [];
      const isColl = collapsedRuns.has(run.id);
      result.push({ type: 'run', run, depth, hasChild: children.length > 0, collapsed: isColl });
      children.forEach(child => traverse(child, depth + 1, isColl));
    }

    rootRuns.forEach(root => traverse(root, 0, false));
  }

  return result;
}

function calculateLevels(runTasks: RunTaskRecord[], getDeps: (id: string) => string[]): Array<{ level: number, tasks: RunTaskRecord[] }> {
  const levels: Record<string, number> = {};
  runTasks.forEach(t => levels[t.taskId] = 0);

  let changed = true;
  for (let iter = 0; iter < 100 && changed; iter++) {
    changed = false;
    runTasks.forEach(t => {
      const deps = getDeps(t.taskId);
      let maxDepLevel = -1;
      deps.forEach(depId => {
        if (levels[depId] !== undefined) {
          maxDepLevel = Math.max(maxDepLevel, levels[depId]);
        }
      });
      const newLevel = maxDepLevel + 1;
      if (levels[t.taskId] !== newLevel) {
        levels[t.taskId] = newLevel;
        changed = true;
      }
    });
  }

  const maxLevel = Math.max(0, ...Object.values(levels));
  const levelGroups: Array<{ level: number, tasks: RunTaskRecord[] }> = [];
  for (let l = 0; l <= maxLevel; l++) {
    const group = runTasks.filter(t => levels[t.taskId] === l);
    if (group.length > 0) {
      levelGroups.push({ level: l, tasks: group });
    }
  }
  return levelGroups;
}

interface TimelineItem {
  id: string;
  time: string;
  type: 'run_start' | 'task_round' | 'human_review' | 'task_active' | 'task_error';
  task?: RunTaskRecord;
  round?: RoundRecord;
  review?: ReviewRecord;
  comment?: string;
  action?: 'approve' | 'revise';
  output?: string;
  agents?: string[];
  durationMs?: number;
  toolCallCount?: number;
}

function buildTimeline(run: RunRecord): TimelineItem[] {
  const items: TimelineItem[] = [];

  items.push({
    id: `start-${run.id}`,
    time: run.startedAt,
    type: 'run_start',
    comment: run.goal,
  });

  run.tasks.forEach((task) => {
    if (task.rounds) {
      task.rounds.forEach((round) => {
        const roundFinishedTime = round.finishedAt || run.startedAt;
        const toolsCount = (round.toolEvents ?? []).flat().filter(e => e.type === 'tool_use').length;

        items.push({
          id: `task-round-${task.taskId}-${round.round}`,
          time: roundFinishedTime,
          type: 'task_round',
          task,
          round,
          output: round.output,
          agents: task.agents,
          toolCallCount: toolsCount,
        });

        if (round.review) {
          items.push({
            id: `review-${task.taskId}-${round.round}`,
            time: round.review.reviewedAt || roundFinishedTime,
            type: 'human_review',
            task,
            round,
            review: round.review,
            comment: round.review.comment,
            action: round.review.action,
          });
        }
      });
    }

    if (task.status === 'running' || task.status === 'awaiting_review' || task.status === 'interrupted' || task.status === 'error') {
      if (task.status === 'running') {
        items.push({
          id: `active-${task.taskId}`,
          time: new Date().toISOString(),
          type: 'task_active',
          task,
          agents: task.agents,
        });
      } else if (task.status === 'awaiting_review' || task.status === 'interrupted') {
        const toolsCount = (task.toolEvents ?? []).flat().filter(e => e.type === 'tool_use').length;
        items.push({
          id: `active-review-${task.taskId}`,
          time: task.finishedAt || new Date().toISOString(),
          type: 'task_round',
          task,
          output: task.output || '',
          agents: task.agents,
          toolCallCount: toolsCount,
        });
      } else if (task.status === 'error') {
        items.push({
          id: `error-${task.taskId}`,
          time: task.finishedAt || new Date().toISOString(),
          type: 'task_error',
          task,
          comment: task.error || 'Unknown error occurred.',
        });
      }
    }
  });

  return items.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool icon
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Bash: '⬛',
  bash: '⬛',
  Read: '📄',
  ReadFile: '📄',
  Write: '✏️',
  WriteFile: '✏️',
  WebSearch: '🔍',
  Search: '🔍',
  Edit: '✏️',
  MultiEdit: '✏️',
  Glob: '📁',
  LS: '📁',
  Grep: '🔎',
};

function toolIcon(name?: string) {
  if (!name) return '🔧';
  return TOOL_ICONS[name] ?? '🔧';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool event display
// ─────────────────────────────────────────────────────────────────────────────

function getToolSummary(event: ToolEvent): string {
  if (!event.input) return '';
  const inp = event.input;
  if (inp.command) return String(inp.command);
  if (inp.path) return String(inp.path);
  if (inp.file_path) return String(inp.file_path);
  if (inp.query) return String(inp.query);
  if (inp.pattern) return String(inp.pattern);
  return JSON.stringify(inp);
}

function getToolLanguage(toolName?: string, input?: Record<string, unknown>): string {
  if (!toolName) return 'text';
  const name = toolName.toLowerCase();
  
  if (name.includes('bash') || name.includes('shell') || name.includes('command') || name.includes('run_command')) {
    return 'bash';
  }
  
  if (input) {
    const filePath = String(input.TargetFile || input.file_path || input.AbsolutePath || input.path || '');
    if (filePath) {
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext === 'ts' || ext === 'tsx') return 'typescript';
      if (ext === 'js' || ext === 'jsx') return 'javascript';
      if (ext === 'json') return 'json';
      if (ext === 'vue' || ext === 'html') return 'html';
      if (ext === 'css') return 'css';
      if (ext === 'py') return 'python';
      if (ext === 'go') return 'go';
      if (ext === 'sh') return 'bash';
      if (ext === 'yaml' || ext === 'yml') return 'yaml';
      if (ext === 'md') return 'markdown';
    }
  }
  
  return 'text';
}

function ToolEventPair({ use, result, index }: {
  use: ToolEvent;
  result?: ToolEvent;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(use);

  const lang = getToolLanguage(use.name, use.input);
  const inputMarkdown = use.input 
    ? `\`\`\`json\n${JSON.stringify(use.input, null, 2)}\n\`\`\``
    : `\`\`\`text\n${summary}\n\`\`\n`;
  const outputMarkdown = result 
    ? `\`\`\`${lang}\n${result.content || '(empty)'}\n\`\`\``
    : '';

  return (
    <div className="border border-zinc-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2 bg-zinc-50 hover:bg-zinc-100 transition-colors text-left"
      >
        <span className="shrink-0 text-sm leading-none">{toolIcon(use.name)}</span>
        <span className="text-xs font-semibold text-zinc-700 shrink-0">{use.name ?? 'Tool'}</span>
        <span className="text-xs font-mono text-zinc-400 truncate flex-1">{summary}</span>
        <span className="shrink-0 text-zinc-300 text-xs">#{index + 1}</span>
        {result?.isError && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-red-100 text-red-600 font-medium">err</span>
        )}
        <ChevronIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="divide-y divide-zinc-100">
          {/* Input */}
          <div className="px-3 py-2">
            <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Input</p>
            <div className="rounded-xl border border-zinc-200/50 bg-zinc-950 p-1 overflow-x-auto max-h-64">
              <Markdown content={inputMarkdown} />
            </div>
          </div>
          {/* Output */}
          {result && (
            <div className="px-3 py-2">
              <p className={`text-[10px] font-medium uppercase tracking-wider mb-1 ${result.isError ? 'text-red-400' : 'text-zinc-400'}`}>
                Output{result.isError ? ' (error)' : ''}
              </p>
              <div className={`rounded-xl border max-h-96 overflow-x-auto p-1 bg-zinc-950 ${
                result.isError ? 'border-red-200/50 bg-red-950/20' : 'border-zinc-200/50 bg-zinc-950'
              }`}>
                <Markdown content={outputMarkdown} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolEventList({ events }: { events: ToolEvent[] }) {
  const items: Array<{ type: 'tool', use: ToolEvent, result?: ToolEvent } | { type: 'text', content: string }> = [];

  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === ev.toolUseId);
      items.push({ type: 'tool', use: ev, result });
    } else if (ev.type === 'text') {
      const last = items[items.length - 1];
      if (last && last.type === 'text') {
        last.content += '\n' + (ev.content ?? '');
      } else {
        items.push({ type: 'text', content: ev.content ?? '' });
      }
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {items.map((item, idx) => {
        if (item.type === 'tool') {
          return <ToolEventPair key={`tool-${item.use.toolUseId ?? idx}`} use={item.use} result={item.result} index={idx} />;
        }
        return (
          <div key={`text-${idx}`} className="px-3 py-3 bg-zinc-50 rounded-lg max-h-64 overflow-y-auto">
            <Markdown content={item.content} />
          </div>
        );
      })}
    </div>
  );
}

function TaskDetailPanel({ task, agents, fullHeight = false, continuationRound }: { task: RunTaskRecord; agents: Agent[]; fullHeight?: boolean; continuationRound?: number }) {
  const status: DetailStatus =
    task.status === 'pending'
      ? 'running'
      : task.status === 'skipped'
        ? 'skipped'
      : task.status === 'awaiting_review'
        ? 'running'
        : task.status;
  const output = task.output ?? '';
  const detail = task.error ?? '';
  // Preserve full execution detail after completion as well.
  const detailEventMode = 'all';

  const agentInfos = task.agents.map((a) => formatAgentInfo(a, agents));
  const agentInfo = agentInfos[0] ?? '';

  return (
    <div className="space-y-3">
      <TaskRoundHistory task={task} agents={agents} continuationRound={continuationRound} />
      <TaskDetailShared
        workers={(task.toolEvents ?? []).length > 0 ? (task.toolEvents ?? []) : [[]]}
        agents={task.agents}
        status={status}
        detail={detail}
        output={output}
        outputs={task.outputs}
        workerStatus={task.workerStatus}
        fullHeight={fullHeight}
        detailEventMode={detailEventMode}
        input={task.input}
        agentInfo={agentInfo}
        agentInfos={agentInfos}
        gitDiff={task.gitDiff}
      />
    </div>
  );
}

function TaskRoundHistory({ task, agents, continuationRound }: { task: RunTaskRecord; agents: Agent[]; continuationRound?: number }) {
  const rounds = task.rounds ?? [];
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  const terminal = task.status === 'done' || task.status === 'error' || task.status === 'terminated' || task.status === 'skipped';
  const activeRound = task.currentRound ?? (sorted.length + 1);
  const hasActiveRow = !terminal && activeRound > 0;

  if (sorted.length === 0 && !hasActiveRow) return null;

  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between border-b border-zinc-100 pb-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Execution History</p>
        <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[10px] font-bold text-zinc-600">
          {sorted.length + (hasActiveRow ? 1 : 0)} record{(sorted.length + (hasActiveRow ? 1 : 0)) > 1 ? 's' : ''}
        </span>
      </div>
      <div className="space-y-2.5">
        {sorted.map((round) => {
          const isRevise = round.review?.action === 'revise';
          const isRoundInherited = continuationRound !== undefined && round.round < continuationRound;
          const roundAgentInfo = task.agents && task.agents.length > 0
            ? task.agents.map(aId => {
                const baseId = getBaseAgentId(aId, agents);
                return formatAgentInfo(baseId, agents);
              }).join(', ')
            : '';

          return (
            <details key={round.round} className={`group rounded-xl border p-3 shadow-sm hover:shadow-md hover:border-zinc-300 transition-all ${
              isRoundInherited 
                ? 'opacity-55 saturate-50 border-dashed border-zinc-200 bg-zinc-50/10 hover:opacity-100 hover:saturate-100 hover:border-solid hover:bg-white' 
                : 'border-zinc-200/60 bg-white'
            }`}>
              <summary className="cursor-pointer select-none text-xs text-zinc-700 font-bold flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold select-none ${
                  isRoundInherited
                    ? 'bg-zinc-100 border border-zinc-200 text-zinc-400'
                    : isRevise 
                      ? 'bg-amber-50 border border-amber-200 text-amber-700' 
                      : 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                }`}>
                  R{round.round}
                </span>
                <span className={`font-semibold ${isRoundInherited ? 'text-zinc-400' : 'text-zinc-800'}`}>
                  {isRoundInherited ? '📥 历史复用轮次' : isRevise ? '↺ Revised' : '✓ Reviewed'}
                </span>
                {roundAgentInfo && (
                  <span className="text-[10px] bg-zinc-100 text-zinc-500 rounded px-1.5 py-0.5 select-none font-mono font-medium">
                    🤖 {roundAgentInfo}
                  </span>
                )}
                <span className="text-[10px] text-zinc-400 font-medium ml-auto font-mono">
                  {formatTime(round.review?.reviewedAt ?? round.finishedAt)}
                </span>
                <svg className="w-3.5 h-3.5 text-zinc-400 group-open:rotate-180 transition-transform shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="mt-3 space-y-3">
                {round.review?.comment && (
                  <div className="bg-indigo-50/40 border-l-2 border-indigo-500 rounded-r-lg p-3 text-xs text-zinc-700">
                    <p className="text-[9px] uppercase tracking-wider text-indigo-500 font-bold mb-1">Human Feedback</p>
                    <p className="italic font-medium leading-relaxed">"{round.review.comment}"</p>
                  </div>
                )}
                {round.output && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 max-h-48 overflow-y-auto shadow-inner text-zinc-100">
                    <p className="text-[9px] uppercase tracking-wider text-zinc-500 font-bold mb-1.5 border-b border-zinc-800 pb-1 flex justify-between">
                      <span>🖥️ Output Snapshot</span>
                      <span className="font-mono">{round.output.length} characters</span>
                    </p>
                    <div className="text-[11px] font-mono leading-relaxed text-zinc-200/95 max-w-none">
                      <Markdown content={round.output} dark />
                    </div>
                  </div>
                )}
              </div>
            </details>
          );
        })}
        {hasActiveRow && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3">
            <div className="flex items-center gap-2.5 text-xs text-indigo-700">
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-bold text-indigo-700">R{activeRound}</span>
              <span className="font-bold">
                {task.status === 'awaiting_review'
                  ? 'Awaiting comment'
                  : task.status === 'interrupted'
                    ? 'Interrupted'
                    : 'Running'}
              </span>
              <span className="ml-auto text-[10px] text-indigo-500 font-mono font-medium">{task.status}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskDetailDialog({
  task,
  onClose,
  run,
  agents = [],
  onContinueStarted,
  onInterrupt,
  onReviewSubmitted,
}: {
  task: RunTaskRecord;
  onClose: () => void;
  run?: RunRecord;
  agents?: Agent[];
  onContinueStarted?: (newRunId: string) => void;
  onInterrupt?: () => void;
  onReviewSubmitted?: () => void;
}) {
  const toolCallCount = (task.toolEvents ?? []).flat().filter((e) => e.type === 'tool_use').length;

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const showReviewPanel = run && agents && onReviewSubmitted && (task.status === 'awaiting_review' || task.status === 'interrupted');
  const showContinuePanel = run && agents && onContinueStarted && (task.status === 'error' || task.status === 'terminated' || (task.status === 'interrupted' && !onReviewSubmitted));

  return (
    <>
      {/* Backdrop overlay */}
      <div 
        className="fixed inset-0 z-40 bg-zinc-900/20 backdrop-blur-[2px] transition-opacity" 
        onClick={onClose} 
      />
      
      {/* Slide-over Drawer Panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 bg-white border-l border-zinc-200/80 shadow-2xl w-full max-w-2xl h-full flex flex-col overflow-hidden transform transition-transform duration-300 ease-out"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-zinc-200 bg-white px-4 py-3 flex items-start gap-3 shrink-0 shadow-sm">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="text-base font-semibold text-zinc-900 leading-snug">{task.taskName}</span>
              {task.status === 'done' && <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">✓ Done</span>}
              {task.status === 'running' && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 animate-pulse">● Running</span>
                  {onInterrupt && (
                    <button
                      onClick={() => {
                        if (window.confirm("确定要终止该任务的执行吗？")) {
                          onInterrupt();
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded bg-red-50 hover:bg-red-100 border border-red-200 hover:border-red-300 px-2 py-0.5 text-xs font-semibold text-red-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                      title="终止任务"
                    >
                      <span className="w-1.5 h-1.5 bg-red-500 rounded-[1px]" />
                      <span>终止</span>
                    </button>
                  )}
                </div>
              )}
              {task.status === 'terminated' && <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300">■ Terminated</span>}
              {task.status === 'skipped' && <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 ring-1 ring-inset ring-zinc-200">○ Skipped</span>}
              {task.status === 'interrupted' && <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300">■ Interrupted</span>}
              {task.status === 'error' && <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">✗ Error</span>}
            </div>
            <div className="flex items-center flex-wrap gap-3 mt-1.5 text-xs text-zinc-500">
              {task.durationMs != null && <span className="flex items-center gap-1">⏱ {formatDuration(task.durationMs)}</span>}
              {toolCallCount > 0 && <span className="flex items-center gap-1">🔧 {toolCallCount} tool calls</span>}
              <span className="flex items-center gap-1">👥 {task.agents.join(', ')}</span>
              {task.gitDiff && (
                <span className="inline-flex items-center gap-0.5 rounded bg-indigo-50 border border-indigo-100/80 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600 select-none">
                  <span>✦</span>
                  <span>Git Diff Enabled</span>
                </span>
              )}
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all shrink-0"
            title="关闭"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 bg-zinc-50/20">
          <TaskDetailPanel task={task} agents={agents} fullHeight continuationRound={run?.continuationRound} />
        </div>

        {showContinuePanel && (
          <div className="border-t border-zinc-150 bg-zinc-50 px-4 py-4 shrink-0 shadow-lg">
            <RunDetailContinuePanel
              run={run}
              agents={agents}
              task={task}
              onStarted={(newRunId) => {
                onContinueStarted(newRunId);
                onClose();
              }}
            />
          </div>
        )}

        {showReviewPanel && (
          <div className="border-t border-zinc-150 bg-zinc-50 px-4 py-4 shrink-0 shadow-lg">
            <RunDetailReviewPanel
              runId={run.id}
              run={run}
              task={task}
              agents={agents}
              onSubmitted={() => {
                onReviewSubmitted?.();
                onClose();
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task record row
// ─────────────────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  run,
  agents = [],
  onContinueStarted,
  onInterrupt,
  onReviewSubmitted,
}: {
  task: RunTaskRecord;
  run?: RunRecord;
  agents?: Agent[];
  onContinueStarted?: (newRunId: string) => void;
  onInterrupt?: () => void;
  onReviewSubmitted?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  
  const allToolEvents = (task.toolEvents ?? []).flat();
  const toolCallCount = allToolEvents.filter((e) => e.type === 'tool_use').length;

  return (
    <>
    <div className={`rounded-xl border overflow-hidden transition-all ${
      task.status === 'error' && task.error !== 'Skipped due to previous task failure' ? 'border-red-200' : task.status === 'interrupted' ? 'border-zinc-300' : 'border-zinc-200'
    }`}>
      <div className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-zinc-50 transition-colors text-left">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex-1 min-w-0 flex items-center gap-3 text-left"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(task.status, task.error)}`} />
          <span className="flex-1 text-sm font-semibold text-zinc-800 truncate">{task.taskName}</span>
          <ChevronIcon className={`w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>

        <div className="flex items-center gap-2 shrink-0">
          {task.status === 'running' && onInterrupt && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInterrupt();
              }}
              className="flex items-center justify-center w-5 h-5 rounded bg-red-50 hover:bg-red-100 border border-red-200 hover:border-red-300 transition-all shadow-sm group shrink-0"
              title="终止流水线"
            >
              <span className="w-1.5 h-1.5 bg-red-500 rounded-[0.5px] group-hover:scale-90 transition-transform" />
            </button>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="text-xs text-indigo-600 font-medium hover:text-indigo-800 hover:underline"
          >
            ↗ Open detail
          </button>
          {task.agents.map((a, i) => (
            <span key={i} className="text-xs text-zinc-400 font-mono">{a}</span>
          ))}
          {toolCallCount > 0 && (
            <span className="rounded-md bg-indigo-50 text-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold">
              🔧 {toolCallCount}
            </span>
          )}
          {task.durationMs != null && (
            <span className="text-xs text-zinc-400">{formatDuration(task.durationMs)}</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-100 px-4 py-3 bg-white space-y-3">
          <TaskDetailPanel task={task} agents={agents} continuationRound={run?.continuationRound} />
        </div>
      )}
    </div>
    {showModal && (
      <TaskDetailDialog
        task={task}
        run={run}
        agents={agents}
        onContinueStarted={onContinueStarted}
        onClose={() => setShowModal(false)}
        onInterrupt={onInterrupt}
        onReviewSubmitted={onReviewSubmitted}
      />
    )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown renderer (shared)
// ─────────────────────────────────────────────────────────────────────────────

type ContentSection = { kind: 'markdown' | 'thinking'; content: string };

function normalizeMixedContent(input: string): string {
  let text = input.replace(/\r\n/g, '\n');
  const escapedNewlineCount = (text.match(/\\n/g) ?? []).length;
  const hasRealNewline = text.includes('\n');

  // Some providers return escaped text blobs; decode for readable markdown.
  if (escapedNewlineCount > 0 && (!hasRealNewline || escapedNewlineCount >= 2)) {
    text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  return text;
}

function splitThinkingSections(input: string): ContentSection[] {
  const content = normalizeMixedContent(input);
  const sections: ContentSection[] = [];
  const re = /<(thinking|think)>([\s\S]*?)<\/\1>/gi;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const before = content.slice(lastIndex, m.index);
    if (before.trim()) sections.push({ kind: 'markdown', content: before });

    const thinking = m[2] ?? '';
    if (thinking.trim()) sections.push({ kind: 'thinking', content: thinking.trim() });
    lastIndex = re.lastIndex;
  }

  const tail = content.slice(lastIndex);
  if (tail.trim()) sections.push({ kind: 'markdown', content: tail });

  if (sections.length === 0) {
    return [{ kind: 'markdown', content }];
  }
  return sections;
}

function Markdown({
  content,
  className,
  markdownClassName,
  dark,
}: {
  content: string;
  className?: string;
  markdownClassName?: string;
  dark?: boolean;
}) {
  return <MarkdownWithThinking content={content} className={className} markdownClassName={markdownClassName} dark={dark} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run detail panel
// ─────────────────────────────────────────────────────────────────────────────

function RunDetailReviewPanel({ runId, run, task, agents, onSubmitted }: {
  runId: string;
  run: RunRecord;
  task: RunTaskRecord;
  agents: Agent[];
  onSubmitted: () => void;
}) {
  const [comment, setComment] = useState('');
  const [action, setAction] = useState<'approve' | 'revise'>(task.status === 'interrupted' ? 'revise' : 'approve');
  const [agentId, setAgentId] = useState('');
  const [targetTaskId, setTargetTaskId] = useState(task.taskId);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [outputFullscreen, setOutputFullscreen] = useState(false);
  const isInterrupted = task.status === 'interrupted';
  const reviewMarkdownClass = 'max-w-none text-sm';

  useEffect(() => {
    setTargetTaskId(task.taskId);
    setSubmitted(false);
    setOutputExpanded(false);
    setOutputFullscreen(false);
  }, [task.taskId]);

  const handleReviewSubmitError = (e: unknown) => {
    const message = (e as Error)?.message ?? 'Submit failed';
    if (isTerminationNoopMessage(message)) {
      // Review already resolved elsewhere (stream delay / duplicate submit) — treat as success.
      setSubmitted(true);
      onSubmitted();
      return;
    }
    setError(message);
  };

  const submitInterruptedReview = async (nextComment: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await api.submitReview(
        runId,
        task.taskId,
        'revise',
        nextComment,
        task.taskId,
        agentId || undefined,
      );
      setSubmitted(true);
      onSubmitted();
    } catch (e) {
      handleReviewSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    const trimmedComment = comment.trim();
    if ((isInterrupted || action === 'revise') && !trimmedComment) {
      setError(isInterrupted ? '请填写评论后继续执行。' : 'Please provide feedback when requesting a revision.');
      return;
    }
    if (isInterrupted) {
      await submitInterruptedReview(trimmedComment);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.submitReview(
        runId,
        task.taskId,
        action,
        trimmedComment,
        action === 'revise' ? targetTaskId : undefined,
        agentId || undefined,
      );
      setSubmitted(true);
      onSubmitted();
    } catch (e) {
      handleReviewSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRejectInterrupt = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.interruptTask(runId, task.taskId);
      setSubmitted(true);
      onSubmitted();
    } catch (e) {
      const message = (e as Error).message;
      if (isTerminationNoopMessage(message)) {
        setSubmitted(true);
        onSubmitted();
        return;
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) return null;

  return (
    <>
      <div className="bg-white rounded-xl border-2 border-amber-300 overflow-hidden shadow-sm">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-2">
        <span className="text-amber-600 text-sm">{isInterrupted ? '■' : '⏸'}</span>
        <span className="text-xs font-semibold text-amber-800">
          {isInterrupted ? `已中断：${task.taskName}` : `Review: ${task.taskName}`}
        </span>
        <span className="text-[10px] text-amber-500 ml-auto">Round {task.currentRound ?? 1}</span>
      </div>
      <div className="px-4 py-3 space-y-3">
        {task.output && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-zinc-500">
              <span>Output · {task.output.length} chars</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOutputExpanded((prev) => !prev)}
                  className="rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
                >
                  {outputExpanded ? '紧凑视图' : '展开视图'}
                </button>
                <button
                  onClick={() => setOutputFullscreen(true)}
                  className="rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
                >
                  全屏查看
                </button>
              </div>
            </div>
            <div className={`overflow-y-auto rounded-lg bg-white p-4 text-sm border border-zinc-200/70 shadow-inner resize-y ${
              outputExpanded ? 'min-h-[34vh] max-h-[62vh]' : 'max-h-56'
            }`}>
              <Markdown content={task.output} markdownClassName={reviewMarkdownClass} />
            </div>
          </div>
        )}
        {!isInterrupted && (
          <div className="flex gap-2">
            <button
              onClick={() => setAction('approve')}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${
                action === 'approve'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : 'bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300'
              }`}
            >
              ✓ Approve & Continue
            </button>
            <button
              onClick={() => setAction('revise')}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${
                action === 'revise'
                  ? 'bg-amber-50 border-amber-300 text-amber-700'
                  : 'bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300'
              }`}
            >
              ↻ Request Revision
            </button>
          </div>
        )}
        <textarea
          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={isInterrupted ? '请输入本次中断原因或补充说明，然后继续执行...' : (action === 'approve' ? 'Optional comment...' : 'Describe what needs to change...')}
        />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500 shrink-0">Agent:</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-indigo-400"
          >
            <option value="">
              Use task default {(() => {
                const defaultAgentId = task.agents?.[0];
                const defaultAgent = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) : null;
                return defaultAgent ? `(${defaultAgent.name || defaultAgent.id})` : (defaultAgentId ? `(${defaultAgentId})` : '');
              })()}
            </option>
            {agents.filter((a) => !!a.role).map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id} ({a.id})</option>
            ))}
          </select>
        </div>
        {!isInterrupted && action === 'revise' && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500 shrink-0">Branch from:</span>
            <select
              value={targetTaskId}
              onChange={(e) => setTargetTaskId(e.target.value)}
              className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-indigo-400"
            >
              {run.tasks.map((item) => (
                <option key={item.taskId} value={item.taskId}>
                  {item.taskName} ({item.taskId})
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleRejectInterrupt}
            disabled={submitting}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-xs font-semibold text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50"
          >
            ■ 拒绝并终止 Pipeline
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className={`rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
              isInterrupted
                ? 'bg-indigo-600 hover:bg-indigo-500'
                : action === 'approve'
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {submitting
              ? 'Submitting...'
              : isInterrupted
                ? '✎ 提交评论并继续'
                : action === 'approve'
                  ? '✓ Approve'
                  : '↻ Submit Revision'}
          </button>
        </div>
      </div>
      </div>
      {task.output && outputFullscreen && (
        <div className="fixed inset-0 z-[120] bg-zinc-950/45 backdrop-blur-md p-2 sm:p-3 md:p-4 flex items-center justify-center animate-fade-in">
          <div className="mx-auto flex h-full w-full max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-zinc-200/50 bg-white/95 shadow-2xl transition-all duration-300 relative">
            
            {/* Top decorative premium accent gradient bar */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
            
            {/* Elegant glassmorphic header */}
            <div className="flex items-center gap-3 border-b border-zinc-200/80 bg-zinc-50/50 backdrop-blur-md px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="flex h-2.5 w-2.5 rounded-full bg-indigo-500 animate-pulse" />
                <span className="text-sm font-bold text-zinc-900 tracking-tight">Technical Review</span>
              </div>
              <span className="rounded bg-indigo-50 border border-indigo-100/60 px-2 py-0.5 text-[10px] font-bold text-indigo-600 truncate max-w-xs md:max-w-md">
                {task.taskName}
              </span>
              <span className="ml-auto text-xs font-semibold text-zinc-400 bg-zinc-100 px-2.5 py-1 rounded-full">
                {task.output.length} characters
              </span>
              <button
                onClick={() => setOutputFullscreen(false)}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-1.5 text-xs font-bold text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-sm cursor-pointer"
              >
                关闭 (Close)
              </button>
            </div>
            
            {/* Spacious content panel with reduced padding */}
            <div className="flex-1 overflow-y-auto bg-zinc-50/60 px-2 py-4 sm:px-4 md:px-6">
              <div className="mx-auto w-full max-w-5xl rounded-2xl border border-zinc-200/60 bg-white p-5 sm:p-8 md:p-10 shadow-xl ring-1 ring-zinc-100/40 relative">
                {/* Decorative inner document top line */}
                <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-500/10 rounded-t-2xl" />
                <Markdown content={task.output} markdownClassName={reviewMarkdownClass} />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RunDetailContinuePanel({
  run,
  agents,
  onStarted,
  task,
  hideHeader,
}: {
  run: RunRecord;
  agents: Agent[];
  onStarted: (newRunId: string) => void;
  task?: RunTaskRecord;
  hideHeader?: boolean;
}) {
  const failedTask = task || run.tasks.find((t) => t.status === 'error' || t.status === 'interrupted' || t.status === 'terminated');
  const currentTaskId = failedTask?.taskId ?? '';
  const [comment, setComment] = useState('');
  const [agentId, setAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    if (!currentTaskId) {
      setError('当前没有可重跑的失败任务。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const activeComment = comment.trim() || 'Re-run';
      const data = await api.continueRun(run.id, currentTaskId, activeComment, agentId || undefined);
      onStarted(data.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const formContent = (
    <div className={`${hideHeader ? 'px-5 py-4' : 'px-4 py-3'} space-y-3`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 shrink-0">当前任务:</span>
        {failedTask ? (
          <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700">
            {failedTask.taskName} ({failedTask.taskId})
          </span>
        ) : (
          <span className="text-red-500">未找到失败任务</span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 shrink-0">Agent:</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-indigo-400"
        >
          <option value="">
            Use task default {(() => {
              const defaultAgentId = failedTask?.agents?.[0];
              const defaultAgent = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) : null;
              return defaultAgent ? `(${defaultAgent.name || defaultAgent.id})` : (defaultAgentId ? `(${defaultAgentId})` : '');
            })()}
          </option>
          {agents.filter((a) => !!a.role).map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id} ({a.id})</option>
          ))}
        </select>
      </div>

      <textarea
        className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="补充本次失败原因、修正方向或新指令（选填，系统默认记录“重新执行”），系统会从当前任务重新执行并继续后续未完成任务..."
      />

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end">
        <button
          onClick={handleContinue}
          disabled={submitting}
          className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50"
        >
          {submitting ? 'Starting...' : '↻ 重跑当前任务'}
        </button>
      </div>
    </div>
  );

  if (hideHeader) {
    return formContent;
  }

  return (
    <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden shadow-sm">
      <div className="border-b border-indigo-100 bg-indigo-50 px-4 py-3 flex items-center gap-2">
        <span className="text-indigo-600 text-sm">↻</span>
        <span className="text-xs font-semibold text-indigo-800">
          重跑当前失败任务（复用历史上下文）
        </span>
      </div>
      {formContent}
    </div>
  );
}

function RunDetailBranchPanel({
  run,
  agents,
  onStarted,
  task,
  hideHeader,
}: {
  run: RunRecord;
  agents: Agent[];
  onStarted: (newRunId: string) => void;
  task: RunTaskRecord;
  hideHeader?: boolean;
}) {
  const currentTaskId = task.taskId;
  const [comment, setComment] = useState('');
  const [agentId, setAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBranch = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const activeComment = comment.trim();
      const data = await api.branchRun(run.id, currentTaskId, activeComment || undefined, agentId || undefined);
      onStarted(data.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const formContent = (
    <div className={`${hideHeader ? 'px-5 py-4' : 'px-4 py-3'} space-y-3`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 shrink-0">当前基石任务:</span>
        <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50/50 px-2 py-1 text-xs font-medium text-emerald-800">
          {task.taskName} ({task.taskId})
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 shrink-0">指派智能体:</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
        >
          <option value="">
            使用任务默认 {(() => {
              const defaultAgentId = task.agents?.[0];
              const defaultAgent = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) : null;
              return defaultAgent ? `(${defaultAgent.name || defaultAgent.id})` : (defaultAgentId ? `(${defaultAgentId})` : '');
            })()}
          </option>
          {agents.filter((a) => !!a.role).map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id} ({a.id})</option>
          ))}
        </select>
      </div>

      <textarea
        className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 resize"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="补充本次分支执行的修正方向或新指令（选填）。若留空，智能体将从头独立重新运行此步骤；若填写评论，智能体将在上一次产出基础上进行增量修改并向后执行下游步骤..."
      />

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end">
        <button
          onClick={handleBranch}
          disabled={submitting}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition-all shadow-sm active:scale-95 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
        >
          <span>{submitting ? 'Starting...' : '🌱 创建分支并执行'}</span>
        </button>
      </div>
    </div>
  );

  if (hideHeader) {
    return formContent;
  }

  return (
    <div className="bg-white rounded-xl border-2 border-emerald-200 overflow-hidden shadow-sm transition-all hover:border-emerald-300">
      <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-3 flex items-center gap-2">
        <span className="text-emerald-600 text-sm">🌱</span>
        <span className="text-xs font-semibold text-emerald-800">
          基于当前成功任务创建分支执行（仅重跑此任务及下游）
        </span>
      </div>
      {formContent}
    </div>
  );
}

interface WorkflowDAGMapProps {
  run: RunRecord;
  pipelines: Pipeline[];
  agents: Agent[];
  onSelectTask: (taskId: string, runId?: string, context?: { task?: RunTaskRecord; run?: RunRecord }) => void;
  onInterruptTask?: (taskId: string) => void;
  onContinueStarted?: (newRunId: string) => void;
  runs?: RunSummary[];
  onSelectRun?: (runId: string) => void;
  isActive: boolean;
}

interface ExecutionNode {
  id: string;
  runId: string;
  taskId: string;
  task: RunTaskRecord;
  run: RunRecord;
  roundLabel: string;
  isCurrentVersion: boolean;
}

interface TaskCardNodeData {
  node: ExecutionNode;
  agents: Agent[];
  isCurrentVersion: boolean;
  onSelectRun?: (runId: string) => void;
  onSelectTask: (taskId: string, runId?: string, context?: { task?: RunTaskRecord; run?: RunRecord }) => void;
  onInterruptTask?: (taskId: string) => void;
  setBranchTask: (task: RunTaskRecord | null) => void;
  setReRunTask: (task: RunTaskRecord | null) => void;
  setModalRun: (run: RunRecord | null) => void;
  run: RunRecord;
  setSelectedNodeId?: (nodeId: string | null) => void;
}

type CustomNode = Node<TaskCardNodeData, 'taskCard'>;

const nodeTypes = {
  taskCard: TaskCardNode,
};

interface SourceDotEdgeData {
  sourceDotColor?: string;
  sourceDotStroke?: string;
  sourceDotRadius?: number;
}

function SourceDotEdge(props: EdgeProps) {
  const edgeData = props.data as SourceDotEdgeData | undefined;
  const fallbackStroke = typeof props.style?.stroke === 'string' ? props.style.stroke : '#cbd5e1';
  const dotColor = edgeData?.sourceDotColor ?? fallbackStroke;
  const dotStroke = edgeData?.sourceDotStroke ?? '#ffffff';
  const dotRadius = edgeData?.sourceDotRadius ?? 6.5;
  let dotX = props.sourceX;
  let dotY = props.sourceY;

  // Position the starting dot perfectly on the card border (50% on, 50% off)
  // based on which handle it starts from, keeping it perfectly aligned with the line.
  if (props.sourceHandleId === 'right') {
    // Right handle: offset is 14px horizontally. Pull it straight back onto the right border.
    dotX = props.sourceX - 14;
    dotY = props.sourceY;
  } else {
    // Bottom handle: offset is 12px vertically. Pull it straight back onto the bottom border.
    dotX = props.sourceX;
    dotY = props.sourceY - 12;
  }

  return (
    <>
      <BezierEdge {...props} />
      <circle
        cx={dotX}
        cy={dotY}
        r={dotRadius}
        fill={dotColor}
        stroke={dotStroke}
        strokeWidth={2.2}
        pointerEvents="none"
      />
    </>
  );
}

const edgeTypes = {
  sourceDot: SourceDotEdge,
};

function TaskCardNode({ data }: NodeProps<CustomNode>) {
  const {
    node,
    agents,
    isCurrentVersion,
    onSelectRun,
    onSelectTask,
    onInterruptTask,
    setBranchTask,
    setReRunTask,
    setModalRun,
    run,
    setSelectedNodeId
  } = data;

  const { task, run: nodeRun, roundLabel } = node;
  const isSkippedDueToFailure = task.error === 'Skipped due to previous task failure';
  const isAwaiting = task.status === 'awaiting_review' || task.status === 'interrupted';
  const isRunning = task.status === 'running';
  const isDone = task.status === 'done';
  const isError = task.status === 'error' && !isSkippedDueToFailure;
  const isTerminated = task.status === 'terminated';
  const isSkipped = task.status === 'skipped' || isSkippedDueToFailure;
  const isPending = task.status === 'pending';

  let bgClass = 'bg-white border-zinc-200 text-zinc-800 hover:border-zinc-300';
  let statusDotClass = 'bg-zinc-400';
  let pulseClass = '';

  if (isDone) {
    bgClass = 'bg-emerald-50/70 border-emerald-200 text-emerald-950 shadow-emerald-50/50 hover:bg-emerald-50 hover:border-emerald-300';
    statusDotClass = 'bg-emerald-500';
  } else if (isRunning) {
    bgClass = 'bg-blue-50/70 border-blue-400 text-blue-950 shadow-blue-50/50 ring-2 ring-blue-100 animate-pulse hover:bg-blue-50';
    statusDotClass = 'bg-blue-500 animate-ping';
    pulseClass = 'animate-pulse';
  } else if (isAwaiting) {
    bgClass = 'bg-amber-50/80 border-amber-400 text-amber-950 shadow-amber-50/50 ring-2 ring-amber-100 hover:bg-amber-50';
    statusDotClass = 'bg-amber-500 animate-pulse';
  } else if (isError) {
    bgClass = 'bg-red-50/80 border-red-300 text-red-950 shadow-red-50/50 ring-2 ring-red-100 hover:bg-red-50 hover:border-red-400';
    statusDotClass = 'bg-red-500';
  } else if (isTerminated) {
    bgClass = 'bg-zinc-100/80 border-zinc-300 text-zinc-800 shadow-zinc-100/70 ring-1 ring-zinc-200 hover:bg-zinc-100';
    statusDotClass = 'bg-zinc-500';
  } else if (isSkipped) {
    bgClass = 'bg-zinc-50/80 border-zinc-200 text-zinc-500 hover:bg-zinc-50';
    statusDotClass = 'bg-zinc-300';
  } else if (isPending) {
    bgClass = 'bg-zinc-50/50 border-zinc-200/60 text-zinc-400';
    statusDotClass = 'bg-zinc-300';
  }

  const parentRoundText = nodeRun.continuedFromRunId ? `Run ${nodeRun.continuationRound ? Math.max(1, nodeRun.continuationRound - 1) : 1}` : null;

  return (
    <div
      className={`w-[260px] rounded-xl border p-4 shadow-sm hover:shadow-md cursor-pointer transition-all hover:-translate-y-0.5 backdrop-blur-sm relative group text-left ${
        isCurrentVersion
          ? 'ring-2 ring-indigo-500/10 border-indigo-300 shadow-indigo-100/50'
          : ''
      } ${bgClass}`}
    >
      {/* Top/Bottom handles: used by vertical logical-dependency edges */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        className="w-2 h-2 !bg-indigo-300 border-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ top: -12 }}
      />
      {/* Left/Right handles: used by horizontal same-level retry lineage edges */}
      <Handle id="left" type="target" position={Position.Left} style={{ top: '50%', opacity: 0, left: -14 }} />
      <Handle id="right" type="source" position={Position.Right} style={{ top: '50%', opacity: 0, right: -14 }} />

      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass}`} />
        <span className={`text-xs font-bold leading-tight flex-1 min-w-0 truncate ${pulseClass}`} title={task.taskName}>
          {task.taskName}
        </span>
        <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${
          isCurrentVersion ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200' : 'bg-zinc-200/80 text-zinc-600'
        }`}>
          {roundLabel} {isCurrentVersion ? '当前' : ''}
        </span>
      </div>

      <div className="flex items-center justify-between text-[9px] text-zinc-400/90 mb-2">
        <span>🤖 {task.agents.map(aId => {
          const ag = agents.find(a => a.id === aId);
          return ag?.name || aId;
        }).join(', ')}</span>
        {task.durationMs != null && (
          <span>⏱ {formatDuration(task.durationMs)}</span>
        )}
      </div>

      {nodeRun.continuationTaskId === task.taskId && parentRoundText && (
        <div className="text-[8px] font-bold text-zinc-400 bg-zinc-100/80 border border-zinc-200 rounded px-1.5 py-0.5 w-fit select-none mb-2">
          {nodeRun.continuationType === 'branch' ? '🌱 分支自' : '↻ 重跑自'} {parentRoundText} 的此任务
        </div>
      )}

      {task.status !== 'pending' && (
        <div className="flex items-center justify-between border-t border-zinc-100/60 pt-2">
          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${
            isDone ? 'bg-emerald-100/60 text-emerald-700' :
            isRunning ? 'bg-blue-100/60 text-blue-700 animate-pulse' :
            isAwaiting ? 'bg-amber-100/60 text-amber-700 animate-pulse' :
            isTerminated ? 'bg-zinc-200/70 text-zinc-700' :
            isSkipped ? 'bg-zinc-100 text-zinc-500' :
            isError ? 'bg-red-100/60 text-red-700' :
            'bg-zinc-100 text-zinc-600'
          }`}>
            {isSkippedDueToFailure ? 'skipped' : statusLabel(task.status)}
          </span>
          
          <div className="flex items-center gap-1.5">
            {isRunning && onInterruptTask && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm("确定要终止该任务的执行吗？")) {
                    onInterruptTask(task.taskId);
                  }
                }}
                className="flex items-center justify-center gap-0.5 rounded bg-red-50 hover:bg-red-100 border border-red-200 hover:border-red-300 px-1.5 py-0.5 text-[8px] font-bold text-red-600 transition-colors shadow-sm cursor-pointer active:scale-95"
              >
                <span>终止</span>
              </button>
            )}
            {isDone && (
              <button
                onClick={(e) => { e.stopPropagation(); setModalRun(nodeRun); setBranchTask(task); }}
                className="flex items-center justify-center rounded bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 hover:border-emerald-300 p-1 text-emerald-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                title="从此任务创建分支"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 2 L4 8" />
                  <path d="M4 8 L4 14" />
                  <path d="M4 5 Q4 5 10 5 L10 14" />
                  <path d="M8 12 L10 14 L12 12" />
                </svg>
              </button>
            )}
            {(isError || isTerminated || task.status === 'interrupted') && (
              <button
                onClick={(e) => { e.stopPropagation(); setModalRun(nodeRun); setReRunTask(task); }}
                className="flex items-center justify-center rounded bg-red-50 hover:bg-red-100 border border-red-200 hover:border-red-300 p-1 text-red-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                title="重跑当前失败任务"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 8a6.5 6.5 0 1 0 1.5-4.2L1.5 6" />
                  <path d="M1.5 1.5v4.5h4.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="w-2 h-2 !bg-indigo-300 border-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ bottom: -12 }}
      />
    </div>
  );
}

function WorkflowDAGMap({
  run,
  pipelines,
  agents,
  onSelectTask,
  onInterruptTask,
  onContinueStarted,
  runs,
  onSelectRun,
  isActive,
}: WorkflowDAGMapProps) {
  const [branchTask, setBranchTask] = useState<RunTaskRecord | null>(null);
  const [reRunTask, setReRunTask] = useState<RunTaskRecord | null>(null);
  const [modalRun, setModalRun] = useState<RunRecord | null>(null);
  const [mapMode, setMapMode] = useState<'lineage' | 'current'>('lineage');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Reset selected node when the run changes
  useEffect(() => {
    setSelectedNodeId(null);
  }, [run.id]);

  const [lineageRuns, setLineageRuns] = useState<Record<string, RunRecord>>({});
  const [loadingLineage, setLoadingLineage] = useState(false);

  const pipeline = pipelines.find((p) => p.id === run.pipelineId);
  const getDeps = useCallback((taskId: string) => {
    return pipeline?.tasks.find((t) => t.id === taskId)?.dependsOn || [];
  }, [pipeline]);

  const lineageSummaries = useMemo(() => {
    return runs ? getLineageChain(run, runs) : [];
  }, [run, runs]);
  const lineageIdsStr = useMemo(() => {
    return lineageSummaries.map(s => s.id).join(',');
  }, [lineageSummaries]);

  // Load missing historical runs in the lineage chain to extract full task details.
  // Use lineageIdsStr dependency to prevent infinite fetch loops during live progress polling.
  useEffect(() => {
    if (lineageSummaries.length === 0) return;

    const fetchLineage = async () => {
      const missingSummaries = lineageSummaries.filter(
        s => s.id !== run.id && !lineageRuns[s.id]
      );

      if (missingSummaries.length === 0) {
        // If all parent runs are already cached, just update the current run's reference (in case it changes)
        setLineageRuns(prev => {
          if (prev[run.id] === run) return prev;
          return { ...prev, [run.id]: run };
        });
        return;
      }

      setLoadingLineage(true);
      const newMap: Record<string, RunRecord> = { ...lineageRuns, [run.id]: run };

      await Promise.all(
        missingSummaries.map(async (summary) => {
          try {
            const fullRecord = await api.getRun(summary.id);
            newMap[summary.id] = fullRecord;
          } catch (err) {
            console.error(`Failed to fetch run ${summary.id}:`, err);
          }
        })
      );
      setLineageRuns(newMap);
      setLoadingLineage(false);
    };

    fetchLineage();
  }, [run.id, lineageIdsStr]);

  const showLineageTopology = lineageSummaries.length > 1;

  // Helper to identify which tasks are active versus inherited/reused for any run
  const getActiveTaskIdsForRun = (targetRun: RunRecord): Set<string> | null => {
    // 1. If schema metadata is present, use it as the primary source of truth
    if (targetRun.continuationTaskId) {
      const activeSet = new Set<string>([targetRun.continuationTaskId]);
      const queue = [targetRun.continuationTaskId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        const directChildren = pipeline?.tasks.filter((t) => t.dependsOn.includes(current)) || [];
        for (const child of directChildren) {
          if (!activeSet.has(child.id)) {
            activeSet.add(child.id);
            queue.push(child.id);
          }
        }
      }
      return activeSet;
    }

    // 2. If it is a root run (not continued from any other run), all tasks are active by definition
    if (!targetRun.continuedFromRunId) {
      return null;
    }

    // 3. Fallback Heuristic for older historical runs:
    const runStartTime = new Date(targetRun.startedAt).getTime();
    const directlyActive = new Set<string>();

    targetRun.tasks.forEach((t) => {
      if (!t.startedAt) return;
      const taskStartTime = new Date(t.startedAt).getTime();
      if (taskStartTime >= runStartTime - 1000) {
        directlyActive.add(t.taskId);
      }
    });

    if (directlyActive.size === 0) {
      return null;
    }

    const activeSet = new Set<string>(directlyActive);
    const queue = Array.from(directlyActive);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const directChildren = pipeline?.tasks.filter((t) => t.dependsOn.includes(current)) || [];
      for (const child of directChildren) {
        if (!activeSet.has(child.id)) {
          activeSet.add(child.id);
          queue.push(child.id);
        }
      }
    }

    return activeSet;
  };

  // Convert pipeline and runs lineages into standard React Flow Nodes & Edges dynamically
  const { flowNodes, flowEdges } = useMemo(() => {
    const nodes: Node<TaskCardNodeData>[] = [];
    const edges: Edge[] = [];

    // Compute Pipeline stage levels topologically
    const pipelineTasks = pipeline?.tasks || [];
    const pipelineLevels: Record<string, number> = {};
    pipelineTasks.forEach(t => pipelineLevels[t.id] = 0);

    let changed = true;
    for (let iter = 0; iter < 100 && changed; iter++) {
      changed = false;
      pipelineTasks.forEach(t => {
        const deps = t.dependsOn || [];
        let maxDepLevel = -1;
        deps.forEach(depId => {
          if (pipelineLevels[depId] !== undefined) {
            maxDepLevel = Math.max(maxDepLevel, pipelineLevels[depId]);
          }
        });
        const newLevel = maxDepLevel + 1;
        if (pipelineLevels[t.id] !== newLevel) {
          pipelineLevels[t.id] = newLevel;
          changed = true;
        }
      });
    }

    if (showLineageTopology && mapMode === 'lineage') {
      // 1. Gather all active ExecutionNodes across lineage
      const allNodesList: ExecutionNode[] = [];
      lineageSummaries.forEach((summary) => {
        const fullRun = lineageRuns[summary.id] || (summary.id === run.id ? run : null);
        if (!fullRun) return;

        const isCurrent = summary.id === run.id;
        const activeTaskIds = getActiveTaskIdsForRun(fullRun);
        fullRun.tasks.forEach((task) => {
          const isActive = activeTaskIds === null || activeTaskIds.has(task.taskId);
          if (isActive) {
            // For historical runs, hide tasks that were never executed (skipped or pending placeholders)
            // to keep the lineage graph clean, compact, and focused on actual evolution paths.
            if (!isCurrent && (task.status === 'skipped' || task.status === 'pending')) {
              return;
            }

            allNodesList.push({
              id: `${summary.id}_${task.taskId}`,
              runId: summary.id,
              taskId: task.taskId,
              task,
              run: fullRun,
              roundLabel: `Run ${summary.continuationRound || 1}`,
              isCurrentVersion: isCurrent,
            });
          }
        });
      });

      // 2. Group nodes by pipeline level
      const levelGroups: Record<number, ExecutionNode[]> = {};
      allNodesList.forEach((n) => {
        const lvl = pipelineLevels[n.taskId] ?? 0;
        if (!levelGroups[lvl]) levelGroups[lvl] = [];
        levelGroups[lvl].push(n);
      });

      // 3. Layout nodes in elegant rows (levels) and columns (runs order)
      Object.keys(levelGroups).forEach((lvlStr) => {
        const lvl = parseInt(lvlStr, 10);
        const group = levelGroups[lvl];

        const getRunOrder = (node: ExecutionNode) => {
          const idx = lineageSummaries.findIndex(s => s.id === node.runId);
          return idx === -1 ? 999 : idx;
        };
        group.sort((a, b) => getRunOrder(a) - getRunOrder(b));

        const rowWidth = (group.length - 1) * 380;
        const startX = -rowWidth / 2;

        group.forEach((node, idx) => {
          nodes.push({
            id: node.id,
            type: 'taskCard',
            position: { x: startX + idx * 380, y: lvl * 280 + 40 },
            data: {
              node,
              agents,
              isCurrentVersion: node.runId === run.id,
              onSelectRun,
              onSelectTask,
              onInterruptTask,
              setBranchTask,
              setReRunTask,
              setModalRun,
              run,
              setSelectedNodeId
            },
          });
        });
      });

      // 4. Generate logical dependency and lineage transition edges
      // Build a quick lookup: nodeId -> task status for edge styling
      const nodeStatusMap = new Map<string, RunTaskRecord['status']>();
      allNodesList.forEach(n => nodeStatusMap.set(n.id, n.task.status));

      allNodesList.forEach((node) => {
        // A. Logical pipeline dependency edges
        // Rule: solid indigo arrow when the dep source task SUCCEEDED (done)
        //       dashed muted arrow when the dep source task failed/skipped (skipping signal)
        const deps = getDeps(node.taskId);
        deps.forEach((depId) => {
          let currentRunId: string | null = node.runId;
          const visited = new Set<string>();

          while (currentRunId) {
            if (visited.has(currentRunId)) break;
            visited.add(currentRunId);

            const r = lineageRuns[currentRunId] || (currentRunId === run.id ? run : null);
            if (!r) break;

            const activeIds = getActiveTaskIdsForRun(r);
            const isActive = activeIds === null || activeIds.has(depId);
            if (isActive) {
              const sourceId = `${currentRunId}_${depId}`;
              const sourceStatus = nodeStatusMap.get(sourceId);
              const isDoneSource = sourceStatus === 'done';
              const isFailedSource = sourceStatus === 'error' || sourceStatus === 'terminated';
              const isSkippedSource = sourceStatus === 'skipped';

              if (isDoneSource) {
                // Solid indigo bezier: upstream task succeeded, passed output to this task
                edges.push({
                  id: `edge_${sourceId}_to_${node.id}`,
                  source: sourceId,
                  target: node.id,
                  sourceHandle: 'bottom',
                  targetHandle: 'top',
                  type: 'sourceDot',
                  style: { stroke: '#818cf8', strokeWidth: 2 },
                  data: { sourceDotColor: '#818cf8' } satisfies SourceDotEdgeData,
                  markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8' },
                });
              } else if (isFailedSource) {
                // Red dashed: upstream task failed — ONLY draw this "causal failure" edge when the
                // target is also a non-success result (skipped / error). If the target is running or
                // done, it clearly got its input from somewhere valid (e.g. a sibling-branch run),
                // so showing a red line from a failed ancestor would be misleading.
                const targetIsBlockedOrFailed = node.task.status === 'skipped' || node.task.status === 'error' || node.task.status === 'terminated';
                if (targetIsBlockedOrFailed) {
                  edges.push({
                    id: `edge_${sourceId}_to_${node.id}`,
                    source: sourceId,
                    target: node.id,
                    sourceHandle: 'bottom',
                    targetHandle: 'top',
                    type: 'sourceDot',
                    style: { stroke: '#f87171', strokeWidth: 1.5, strokeDasharray: '4 4', opacity: 0.65 },
                    data: { sourceDotColor: '#f87171' } satisfies SourceDotEdgeData,
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#f87171' },
                  });
                }
              } else if (isSkippedSource) {
                // Dashed zinc: upstream was skipped, cascading skip signal — same gate as above.
                const targetIsSkipped = node.task.status === 'skipped';
                if (targetIsSkipped) {
                  edges.push({
                    id: `edge_${sourceId}_to_${node.id}`,
                    source: sourceId,
                    target: node.id,
                    sourceHandle: 'bottom',
                    targetHandle: 'top',
                    type: 'sourceDot',
                    style: { stroke: '#a1a1aa', strokeWidth: 1.5, strokeDasharray: '4 4', opacity: 0.5 },
                    data: { sourceDotColor: '#a1a1aa' } satisfies SourceDotEdgeData,
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#a1a1aa' },
                  });
                }
              } else {
                // Fallback for running/pending states: neutral solid grey
                edges.push({
                  id: `edge_${sourceId}_to_${node.id}`,
                  source: sourceId,
                  target: node.id,
                  sourceHandle: 'bottom',
                  targetHandle: 'top',
                  type: 'sourceDot',
                  style: { stroke: '#cbd5e1', strokeWidth: 1.5 },
                  data: { sourceDotColor: '#cbd5e1' } satisfies SourceDotEdgeData,
                  markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
                });
              }
              break;
            }

            const summary = lineageSummaries.find((s) => s.id === currentRunId);
            currentRunId = summary?.continuedFromRunId || null;
          }
        });

        // B. Version lineage transition edges (marching ants animation)
        // The FAILED task in the old run gets an amber dashed arrow pointing TO the new retry task.
        // Source: the SAME TASK in the previous run (e.g. R2_落地者 error → R3_落地者 running)
        // Since source and target are ALWAYS the same taskId, they are always at the same pipeline level.
        // To avoid a misleading U-shaped upward route through upper rows, we use the horizontal
        // left/right side handles instead of the default top/bottom handles.
        if (node.run.continuationTaskId === node.taskId && node.run.continuedFromRunId) {
          const sourceId = `${node.run.continuedFromRunId}_${node.taskId}`;
          const isBranch = node.run.continuationType === 'branch';
          edges.push({
            id: `edge_lineage_${node.run.continuedFromRunId}_to_${node.id}`,
            source: sourceId,
            target: node.id,
            // Use right → left handles so the edge routes horizontally at the same row
            // instead of curving upward through parent rows.
            sourceHandle: 'right',
            targetHandle: 'left',
            type: 'sourceDot',
            animated: true,
            style: { stroke: isBranch ? '#34d399' : '#f59e0b', strokeWidth: 2, strokeDasharray: '6 3' },
            data: { sourceDotColor: isBranch ? '#34d399' : '#f59e0b' } satisfies SourceDotEdgeData,
            markerEnd: { type: MarkerType.ArrowClosed, color: isBranch ? '#34d399' : '#f59e0b' },
            label: isBranch ? '🌱 branch' : '↻ retry',
            labelStyle: { fontSize: 9, fontWeight: 700, fill: isBranch ? '#065f46' : '#92400e' },
            labelBgStyle: { fill: isBranch ? '#d1fae5' : '#fef3c7', borderRadius: 4 },
          });
        }
      });

    } else {
      // Current DAG mode:
      const levelGroups: Record<number, RunTaskRecord[]> = {};
      run.tasks.forEach((task) => {
        const lvl = pipelineLevels[task.taskId] ?? 0;
        if (!levelGroups[lvl]) levelGroups[lvl] = [];
        levelGroups[lvl].push(task);
      });

      Object.keys(levelGroups).forEach((lvlStr) => {
        const lvl = parseInt(lvlStr, 10);
        const group = levelGroups[lvl];
        const rowWidth = (group.length - 1) * 380;
        const startX = -rowWidth / 2;

        group.forEach((task, idx) => {
          const mockNode: ExecutionNode = {
            id: `${run.id}_${task.taskId}`,
            runId: run.id,
            taskId: task.taskId,
            task,
            run,
            roundLabel: `Run ${run.continuationRound || 1}`,
            isCurrentVersion: true,
          };
          nodes.push({
            id: mockNode.id,
            type: 'taskCard',
            position: { x: startX + idx * 380, y: lvl * 280 + 40 },
            data: {
              node: mockNode,
              agents,
              isCurrentVersion: true,
              onSelectRun,
              onSelectTask,
              onInterruptTask,
              setBranchTask,
              setReRunTask,
              setModalRun,
              run,
              setSelectedNodeId
            },
          });
        });
      });

      run.tasks.forEach((task) => {
        const deps = getDeps(task.taskId);
        deps.forEach((depId) => {
          edges.push({
            id: `edge_${run.id}_${depId}_to_${run.id}_${task.taskId}`,
            source: `${run.id}_${depId}`,
            target: `${run.id}_${task.taskId}`,
            sourceHandle: 'bottom',
            targetHandle: 'top',
            type: 'sourceDot',
            style: { stroke: '#cbd5e1', strokeWidth: 2 },
            data: { sourceDotColor: '#cbd5e1' } satisfies SourceDotEdgeData,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: '#cbd5e1',
            },
          });
        });
      });
    }

    // Post-process edges to handle active task highlights and animations
    const processedEdges = edges.map((edge) => {
      const isSelected = selectedNodeId !== null;
      if (!isSelected) {
        // Default mode: all edges are static
        return {
          ...edge,
          animated: false,
        };
      }

      const isConnected = edge.source === selectedNodeId || edge.target === selectedNodeId;
      if (isConnected) {
        // Highlighted path: make it dynamic/animated and ensure full opacity
        const existingStyle = edge.style || {};
        return {
          ...edge,
          animated: true,
          style: {
            ...existingStyle,
            strokeWidth: typeof existingStyle.strokeWidth === 'number' ? existingStyle.strokeWidth + 0.5 : 2.5,
            opacity: 1,
          },
        };
      } else {
        // Muted path: dim the inactive edges and turn off animation
        const existingStyle = edge.style || {};
        return {
          ...edge,
          animated: false,
          style: {
            ...existingStyle,
            opacity: 0.15,
          },
          label: undefined, // Hide labels for inactive edges to declutter
        };
      }
    });

    return { flowNodes: nodes, flowEdges: processedEdges };
  }, [run, runs, lineageRuns, mapMode, pipeline, agents, onSelectRun, onSelectTask, onInterruptTask, selectedNodeId]);

  const fitTrigger = `${run.id}:${mapMode}:${flowNodes.length}:${flowEdges.length}:${isActive ? 'active' : 'hidden'}`;

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node<TaskCardNodeData>) => {
    const target = event.target as HTMLElement;
    // Prevent selection if clicked on buttons or other interactive controls inside the card
    if (target.closest('button') || target.closest('svg') || target.closest('select')) {
      return;
    }
    setSelectedNodeId(node.id);
    const taskNode = node.data?.node;
    if (!taskNode) return;
    onSelectTask(taskNode.taskId, taskNode.runId, { task: taskNode.task, run: taskNode.run });
  }, [onSelectTask]);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  return (
    <>
      {/* Topology Header Mode Controller */}
      {showLineageTopology && (
        <div className="px-5 py-2.5 bg-zinc-50 border-b border-zinc-200/60 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-zinc-500">拓扑图模式:</span>
            <button
              onClick={() => setMapMode('lineage')}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-all ${
                mapMode === 'lineage'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              🌳 完整历史拓扑演进树 (Evolution Tree)
            </button>
            <button
              onClick={() => setMapMode('current')}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-all ${
                mapMode === 'current'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              📌 当前版本依赖 DAG (Current)
            </button>
          </div>
          {loadingLineage && (
            <div className="flex items-center gap-1.5 text-zinc-400 text-[10px]">
              <Spinner />
              <span>载入关系链中...</span>
            </div>
          )}
        </div>
      )}

      {/* Main Panel View utilizing React Flow Canvas */}
      <div className="w-full flex-1 bg-zinc-50/20 relative select-none">
        {loadingLineage && Object.keys(lineageRuns).length < lineageSummaries.length ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-50/70 z-10 text-zinc-400 text-xs backdrop-blur-[1px]">
            <Spinner />
            <span className="mt-3">正在解析历史依赖演进树...</span>
          </div>
        ) : null}

        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          minZoom={0.2}
          maxZoom={1.5}
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <MapAutoFit trigger={fitTrigger} active={isActive} />
          <Background color="#cbd5e1" gap={18} size={1} />
          <Controls className="!bg-white !border-zinc-200 !shadow-md !rounded-lg" />
        </ReactFlow>
      </div>

      {/* Branch modal */}
      {branchTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => { setBranchTask(null); setModalRun(null); }}
        >
          <div
            className="w-full max-w-lg mx-4 shadow-2xl rounded-2xl overflow-hidden bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 bg-emerald-50 border-b border-emerald-100">
              <div className="flex items-center gap-2">
                <span className="text-emerald-600 text-sm">🌱</span>
                <span className="text-sm font-semibold text-emerald-800">
                  基于当前成功任务创建分支（仅重跑此任务及下游）
                </span>
              </div>
              <button
                onClick={() => { setBranchTask(null); setModalRun(null); }}
                className="text-emerald-500 hover:text-emerald-700 transition-colors p-1.5 rounded hover:bg-emerald-100/50 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <RunDetailBranchPanel
              run={modalRun || run}
              agents={agents}
              task={branchTask!}
              hideHeader={true}
              onStarted={(newRunId) => {
                setBranchTask(null);
                setModalRun(null);
                onContinueStarted?.(newRunId);
              }}
            />
          </div>
        </div>
      )}

      {/* Re-run modal */}
      {reRunTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => { setReRunTask(null); setModalRun(null); }}
        >
          <div
            className="w-full max-w-lg mx-4 shadow-2xl rounded-2xl overflow-hidden bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 bg-indigo-50 border-b border-indigo-100">
              <div className="flex items-center gap-2">
                <span className="text-indigo-600 text-sm">↻</span>
                <span className="text-sm font-semibold text-indigo-800">
                  重跑当前失败任务（复用历史上下文）
                </span>
              </div>
              <button
                onClick={() => { setReRunTask(null); setModalRun(null); }}
                className="text-indigo-500 hover:text-indigo-700 transition-colors p-1.5 rounded hover:bg-indigo-100/50 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <RunDetailContinuePanel
              run={modalRun || run}
              agents={agents}
              task={reRunTask!}
              hideHeader={true}
              onStarted={(newRunId) => {
                setReRunTask(null);
                setModalRun(null);
                onContinueStarted?.(newRunId);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

interface ChronologicalTimelineProps {
  run: RunRecord;
  onSelectTask: (taskId: string, runId?: string, context?: { task?: RunTaskRecord; run?: RunRecord }) => void;
}

function ChronologicalTimeline({ run, onSelectTask }: ChronologicalTimelineProps) {
  const timelineItems = buildTimeline(run);

  if (timelineItems.length === 0) {
    return (
      <div className="p-10 text-center text-zinc-400 text-xs">
        No chronological events recorded yet.
      </div>
    );
  }

  return (
    <div className="px-6 py-6 bg-zinc-50/30 max-h-[70vh] overflow-y-auto">
      <div className="max-w-2xl mx-auto pl-4 border-l-2 border-indigo-100 space-y-6 relative">
        {timelineItems.map((item) => {
          const timeStr = formatTime(item.time);
          const timeDur = item.durationMs != null ? formatDuration(item.durationMs) : '';

          if (item.type === 'run_start') {
            return (
              <div key={item.id} className="relative -ml-[25px] flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-zinc-950 text-white flex items-center justify-center shadow-md select-none">
                  🎬
                </div>
                <div className="flex-1 mt-1 bg-white border border-zinc-200/80 rounded-xl px-4 py-3 shadow-sm">
                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Goal / Objective</p>
                  <p className="text-xs font-semibold text-zinc-800 mt-1 leading-relaxed italic">
                    "{item.comment}"
                  </p>
                  <p className="text-[9px] text-zinc-400 font-mono mt-1.5">{timeStr}</p>
                </div>
              </div>
            );
          }

          if (item.type === 'task_round' && item.task && item.round) {
            return (
              <div key={item.id} className="relative -ml-[25px] flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center shadow-md border-2 border-white select-none">
                  🤖
                </div>
                <div className="flex-1 bg-white border border-zinc-200/80 rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                  {/* Bubble header */}
                  <div className="bg-indigo-50/50 px-4 py-2 border-b border-zinc-100 flex items-center gap-2 flex-wrap">
                    <span className="rounded bg-indigo-100 border border-indigo-200 text-indigo-700 text-[10px] font-bold px-1.5 py-0.5">
                      R{item.round.round}
                    </span>
                    <span 
                      onClick={() => onSelectTask(item.task!.taskId, run.id)}
                      className="text-xs font-bold text-zinc-800 cursor-pointer hover:text-indigo-600 hover:underline"
                    >
                      {item.task.taskName}
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono ml-auto">
                      {item.agents?.join(', ')}
                    </span>
                  </div>

                  {/* Bubble body */}
                  <div className="p-4 space-y-2">
                    <div className="flex items-center gap-3 text-[10px] text-zinc-400 flex-wrap">
                      {item.toolCallCount! > 0 && (
                        <span className="bg-zinc-100 rounded px-1.5 py-0.5 text-zinc-600 font-medium">
                          🔧 {item.toolCallCount} tools used
                        </span>
                      )}
                      {timeDur && <span>⏱ {timeDur}</span>}
                      <span className="ml-auto font-mono">{timeStr}</span>
                    </div>

                    {item.output && (
                      <details className="group mt-2">
                        <summary className="cursor-pointer select-none text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1">
                          <span>View Output Snapshot</span>
                          <span className="group-open:rotate-180 transition-transform text-[8px]">▼</span>
                        </summary>
                        <div className="mt-2 max-h-60 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-[11px] text-white border border-zinc-800 shadow-inner">
                          <Markdown content={item.output} />
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            );
          }

          if (item.type === 'human_review' && item.task && item.review) {
            const isRevise = item.action === 'revise';
            return (
              <div key={item.id} className="relative -ml-[25px] flex items-start gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shadow-md border-2 border-white select-none ${
                  isRevise ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white'
                }`}>
                  👤
                </div>
                <div className={`flex-1 rounded-xl border-2 p-4 shadow-sm relative ${
                  isRevise 
                    ? 'bg-amber-50/20 border-amber-200/80 text-amber-900 shadow-amber-50/10'
                    : 'bg-emerald-50/20 border-emerald-200/80 text-emerald-900 shadow-emerald-50/10'
                }`}>
                  <div className="flex items-center justify-between border-b border-black/5 pb-1.5 mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                        isRevise ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {isRevise ? '↺ Revision' : '✓ Approved'}
                      </span>
                      <span className="text-xs font-bold">Human Feedback</span>
                    </div>
                    <span className="text-[10px] opacity-60 font-mono">{timeStr}</span>
                  </div>

                  {item.review.targetTaskId && item.review.targetTaskId !== item.task.taskId && (
                    <p className="text-[10px] font-bold text-amber-700 mb-2 bg-amber-100 border border-amber-200 rounded px-2 py-0.5 w-fit">
                      ↺ Branched back to Task: "{run.tasks.find(t => t.taskId === item.review!.targetTaskId)?.taskName || item.review.targetTaskId}"
                    </p>
                  )}

                  <p className="text-xs font-medium whitespace-pre-wrap leading-relaxed italic bg-white/50 rounded-lg p-2.5 border border-black/5 shadow-inner">
                    "{item.comment || 'Approved without comment.'}"
                  </p>
                </div>
              </div>
            );
          }

          if (item.type === 'task_error' && item.task) {
            return (
              <div key={item.id} className="relative -ml-[25px] flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center shadow-md border-2 border-white select-none">
                  ✗
                </div>
                <div className="flex-1 rounded-xl border border-red-200 bg-red-50/20 p-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-red-100 pb-1.5 mb-2">
                    <span className="text-xs font-bold text-red-800">Task Error: {item.task.taskName}</span>
                    <span className="text-[10px] text-red-500 font-mono">{timeStr}</span>
                  </div>
                  <pre className="text-[11px] font-mono text-red-600 bg-red-50/50 rounded-lg p-3 overflow-x-auto border border-red-100/50 shadow-inner max-h-40">
                    {item.comment}
                  </pre>
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

function MapAutoFit({ trigger, active }: { trigger: string; active: boolean }) {
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);

  useEffect(() => {
    fitViewRef.current = fitView;
  }, [fitView]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      fitViewRef.current({ padding: 0.2, duration: 240 });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [active, trigger]);

  return null;
}

function RunDetail({
  run,
  agents,
  pipelines,
  runs,
  onReviewSubmitted,
  onContinueStarted,
  onInterruptTask,
  onSelectTask,
  onSelectRun,
}: {
  run: RunRecord;
  agents: Agent[];
  pipelines: Pipeline[];
  runs: RunSummary[];
  onReviewSubmitted: () => void;
  onContinueStarted: (newRunId: string) => void;
  onInterruptTask?: (taskId: string) => void;
  onSelectTask: (taskId: string, runId?: string, context?: { task?: RunTaskRecord; run?: RunRecord }) => void;
  onSelectRun: (runId: string) => void;
}) {
  const awaitingTask = run.tasks.find((t) => t.status === 'awaiting_review' || t.status === 'interrupted');
  const [viewTab, setViewTab] = useState<'map' | 'timeline' | 'tasks'>('map');

  const lineageChain = getLineageChain(run, runs);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white">

      <div className="px-5 py-5 border-b border-zinc-100 shrink-0">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-mono text-zinc-400">{run.pipelineId}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColors(run.status)}`}>
                {statusLabel(run.status)}
              </span>

              {/* Premium Version Switcher pill */}
              {lineageChain.length > 1 && (
                <div className="relative flex items-center">
                  <select
                    value={run.id}
                    onChange={(e) => onSelectRun(e.target.value)}
                    className="appearance-none rounded-full bg-indigo-50 border border-indigo-200 pl-3 pr-7 py-0.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition-all outline-none cursor-pointer shadow-sm"
                  >
                    {lineageChain.map((r, idx) => {
                      const isCurrent = r.id === run.id;
                      const label = idx === 0
                        ? `🎬 原始执行`
                        : `${r.continuationType === 'branch' ? '🌱 分支' : '↻ 重跑'}: ${r.continuationTaskName || '任务'} (Run ${r.continuationRound || 1})`;
                      return (
                        <option key={r.id} value={r.id}>
                          {label} {isCurrent ? ' (当前)' : ''}
                        </option>
                      );
                    })}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-indigo-500">
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              )}
            </div>
            <h2 className="text-sm font-semibold text-zinc-800 leading-snug">{run.pipelineName}</h2>
          </div>
          <span className="text-xs text-zinc-400 shrink-0">{formatTime(run.startedAt)}</span>
        </div>

        {/* Goal */}
        <div className="bg-zinc-50 rounded-lg px-3 py-2 mb-3">
          <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-0.5">Goal</p>
          <p className="text-xs text-zinc-700 leading-relaxed">{run.goal}</p>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 text-xs text-zinc-500 mb-1">
          <span>⏱ {formatDuration(run.durationMs)}</span>
          <span>📋 {run.taskCount} task{run.taskCount !== 1 ? 's' : ''}</span>
          {run.toolCallCount > 0 && <span>🔧 {run.toolCallCount} tool call{run.toolCallCount !== 1 ? 's' : ''}</span>}
          <span className="text-zinc-300 font-mono text-[10px]">{run.id}</span>
        </div>

        {/* Premium sticky alert banner for awaiting review */}
        {awaitingTask && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200/80 rounded-xl flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-amber-500 text-sm shrink-0">⏸</span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-800">流水线已暂停，等待人工 Review</p>
                <p className="text-[10px] text-amber-600 truncate mt-0.5">任务: {awaitingTask.taskName}</p>
              </div>
            </div>
            <button
              onClick={() => onSelectTask(awaitingTask.taskId, run.id)}
              className="shrink-0 rounded-lg bg-amber-600 hover:bg-amber-700 px-3 py-1.5 text-[10px] font-bold text-white shadow-sm transition-colors active:scale-95 cursor-pointer ml-3"
            >
              ✍️ 去处理
            </button>
          </div>
        )}
      </div>

      {/* Tabs list styled for high aesthetics */}
      <div className="flex border-b border-zinc-200 bg-zinc-50/50 px-5 shrink-0">
        <button
          onClick={() => setViewTab('map')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all -mb-px flex items-center gap-1.5 ${
            viewTab === 'map'
              ? 'border-indigo-600 text-indigo-600 bg-white shadow-sm rounded-t-lg border-x border-t border-zinc-200'
              : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
          }`}
        >
          🗺️ Workflow Map
        </button>
        <button
          onClick={() => setViewTab('timeline')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all -mb-px flex items-center gap-1.5 ${
            viewTab === 'timeline'
              ? 'border-indigo-600 text-indigo-600 bg-white shadow-sm rounded-t-lg border-x border-t border-zinc-200'
              : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
          }`}
        >
          💬 Action Timeline
        </button>
        <button
          onClick={() => setViewTab('tasks')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all -mb-px flex items-center gap-1.5 ${
            viewTab === 'tasks'
              ? 'border-indigo-600 text-indigo-600 bg-white shadow-sm rounded-t-lg border-x border-t border-zinc-200'
              : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
          }`}
        >
          📋 Tasks Checklist
        </button>
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-hidden min-h-0 relative bg-zinc-50/10 flex flex-col">
        {viewTab === 'map' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <WorkflowDAGMap
              run={run}
              pipelines={pipelines}
              agents={agents}
              onSelectTask={onSelectTask}
              onInterruptTask={onInterruptTask}
              onContinueStarted={onContinueStarted}
              runs={runs}
              onSelectRun={onSelectRun}
              isActive={viewTab === 'map'}
            />
          </div>
        )}

        {viewTab === 'timeline' && (
          <div className="h-full overflow-y-auto">
            <ChronologicalTimeline
              run={run}
              onSelectTask={onSelectTask}
            />
          </div>
        )}

        {viewTab === 'tasks' && (
          <div className="h-full overflow-y-auto px-5 py-4 space-y-3">
            {run.tasks.map((task) => (
              <TaskRow
                key={task.taskId}
                task={task}
                run={run}
                agents={agents}
                onContinueStarted={onContinueStarted}
                onInterrupt={onInterruptTask ? () => onInterruptTask(task.taskId) : undefined}
                onReviewSubmitted={onReviewSubmitted}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Run list card
// ─────────────────────────────────────────────────────────────────────────────

function RunCard({ run, selected, onClick, onDelete, hasChild, collapsed, onToggleCollapse, isChild }: {
  run: RunSummary;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
  hasChild?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isChild?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={`w-full group relative flex flex-col gap-0.5 pl-2 pr-4 py-2.5 text-left hover:bg-zinc-50 cursor-pointer transition-colors ${
        selected ? 'bg-indigo-50/40 border-l-2 border-l-indigo-500 font-medium' : 'border-l-2 border-l-transparent'
      }`}
    >
      {/* Line 1: [collapse btn] goal + status */}
      <div className="flex items-center gap-1">
        <div className="w-5 h-5 flex items-center justify-center shrink-0">
          {hasChild ? (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              className="p-0.5 rounded hover:bg-zinc-200/60 text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              <svg className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : null}
        </div>
        <p className={`text-xs truncate leading-snug flex-1 pr-1 ${
          isChild ? 'text-indigo-600 font-bold' : 'text-zinc-700 font-semibold'
        }`}>
          {isChild && run.continuationTaskName ? (
            <span className="flex items-center gap-1">
              <span>{run.continuationType === 'branch' ? '🌱' : '↻'}</span>
              <span>{run.continuationType === 'branch' ? '分支' : '重跑'}: {run.continuationTaskName} (Run {run.continuationRound})</span>
            </span>
          ) : run.goal}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Are you sure you want to delete this run record?')) {
                onDelete();
              }
            }}
            className={`text-zinc-300 hover:text-red-500 transition-all p-1 rounded hover:bg-red-50 ${
              selected ? 'opacity-90' : 'opacity-0 group-hover:opacity-100'
            }`}
            title="Delete run"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
            </svg>
          </button>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors(run.status)}`}>
            {statusLabel(run.status)}
          </span>
        </div>
      </div>
      {/* Line 2: type badge (if any) + time info */}
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 pl-6">
        {isChild && (
          <span className="text-zinc-500 font-normal truncate max-w-[130px] select-none" title={run.goal}>
            目标: {run.goal}
          </span>
        )}
        {isChild && <span className="select-none text-zinc-300">·</span>}
        <span>{formatTime(run.startedAt)}</span>
        <span>·</span>
        <span>{formatDuration(run.durationMs)}</span>
        {run.toolCallCount > 0 && (
          <>
            <span>·</span>
            <span>🔧 {run.toolCallCount}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RunsPage
// ─────────────────────────────────────────────────────────────────────────────

type ActiveTaskSelection = {
  runId: string;
  taskId: string;
  taskSnapshot?: RunTaskRecord;
  runSnapshot?: RunRecord;
};

export function RunsPage() {
  const { t } = useTranslation();
  const initialRouteRef = useRef(readRunsHashParams());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [activeTaskSelection, setActiveTaskSelection] = useState<ActiveTaskSelection | null>(() => {
    const { runId, taskId } = initialRouteRef.current;
    return runId && taskId ? { runId, taskId } : null;
  });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialRouteRef.current.runId);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [collapsedPipelines, setCollapsedPipelines] = useState<Set<string>>(new Set());
  const [collapsedRuns, setCollapsedRuns] = useState<Set<string>>(new Set());
  const sseRef = useRef<{ abort: () => void } | null>(null);

  const toggleCollapse = useCallback((runId: string) => {
    setCollapsedRuns(prev => {
      const next = new Set(prev);
      next.has(runId) ? next.delete(runId) : next.add(runId);
      return next;
    });
  }, []);

  const togglePipelineCollapse = useCallback((pipelineId: string) => {
    setCollapsedPipelines((prev) => {
      const next = new Set(prev);
      if (next.has(pipelineId)) {
        next.delete(pipelineId);
      } else {
        next.add(pipelineId);
      }
      return next;
    });
  }, []);

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const data = await api.getRuns();
      setRuns(data);
      setSelectedId((prevSelected) => {
        if (prevSelected || data.length === 0) return prevSelected;
        return data[0].id;
      });
    } catch { /* silent */ } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const handleDeleteRun = useCallback(async (runId: string) => {
    try {
      const { success } = await api.deleteRun(runId);
      if (success) {
        if (selectedId === runId) {
          setSelectedId(null);
          setSelectedRun(null);
          setActiveTaskSelection(null);
        }
        await load(true);
      }
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }, [selectedId, load]);

  const handleDeletePipelineRuns = useCallback(async (pipelineId: string, pipelineName: string) => {
    const targets = runs.filter((r) => r.pipelineId === pipelineId);
    if (targets.length === 0) return;

    if (!window.confirm(`确定删除一级菜单「${pipelineName}」下的全部 ${targets.length} 条运行记录吗？此操作不可撤销。`)) {
      return;
    }

    const deletedIds = new Set<string>();
    let failed = 0;

    for (const item of targets) {
      try {
        const { success } = await api.deleteRun(item.id);
        if (success) {
          deletedIds.add(item.id);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    if (deletedIds.size === 0) {
      alert('批量删除失败，请稍后重试。');
      return;
    }

    if (selectedId && deletedIds.has(selectedId)) {
      setSelectedId(null);
      setSelectedRun(null);
      setActiveTaskSelection(null);
    }

    await load(true);

    if (failed > 0) {
      alert(`已删除 ${deletedIds.size} 条记录，仍有 ${failed} 条删除失败，请刷新后重试。`);
    }
  }, [runs, selectedId, load]);

  const handleSelectRun = useCallback((runId: string) => {
    setSelectedId(runId);
  }, []);

  const handleSelectTask = useCallback((taskId: string, runId?: string, context?: { task?: RunTaskRecord; run?: RunRecord }) => {
    const targetRunId = runId ?? selectedRun?.id ?? selectedId;
    if (!targetRunId) return;
    setActiveTaskSelection({
      runId: targetRunId,
      taskId,
      taskSnapshot: context?.task,
      runSnapshot: context?.run,
    });
  }, [selectedId, selectedRun?.id]);

  const handleInterruptTask = async (taskId: string) => {
    if (!selectedId) return;
    try {
      await api.interruptTask(selectedId, taskId);
      const detail = await api.getRun(selectedId);
      setSelectedRun(detail);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isTerminationNoopMessage(message)) {
        try {
          const detail = await api.getRun(selectedId);
          setSelectedRun(detail);
        } catch {
          // Ignore refresh failure for idempotent terminate race.
        }
        return;
      }
      console.error('Failed to terminate run:', e);
      alert('Failed to terminate run: ' + message);
    }
  };

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    api.getPipelines().then(setPipelines).catch(() => {});
  }, []);

  // Apply SSE event to the selected run in-place
  const applyRunEvent = useCallback((type: RunEventType, data: unknown) => {
    const d = data as Record<string, unknown>;
    setSelectedRun((prev) => {
      if (!prev) return prev;
      // Deep clone tasks and their toolEvents to avoid mutating previous state
      const run = {
        ...prev,
        tasks: prev.tasks.map((t) => ({
          ...t,
          toolEvents: t.toolEvents ? t.toolEvents.map((w) => w ? [...w] : []) : undefined,
        })),
      };

      if (type === 'task:start') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          task.status = 'running';
          task.startedAt = new Date().toISOString();
          task.finishedAt = undefined;
          task.durationMs = undefined;
          task.error = undefined;
          task.output = '';
          task.outputs = undefined;
          task.toolEvents = [];
          task.workerStatus = task.agents.length > 1 ? task.agents.map(() => 'running') : undefined;
        }
      } else if (type === 'task:tool_event') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        const event = d.event as ToolEvent;
        const workerIndex = (d.workerIndex as number) ?? 0;
        if (task && event) {
          if (!task.toolEvents) task.toolEvents = [];
          // Ensure all slots up to workerIndex are initialized
          while (task.toolEvents.length <= workerIndex) task.toolEvents.push([]);
          task.toolEvents[workerIndex] = [...task.toolEvents[workerIndex], event];
        }
      } else if (type === 'worker:complete') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        const workerIndex = (d.workerIndex as number) ?? 0;
        if (task) {
          if (!task.workerStatus) task.workerStatus = task.agents.map(() => 'running');
          while (task.workerStatus.length <= workerIndex) task.workerStatus.push('running');
          task.workerStatus[workerIndex] = d.error ? 'error' : 'done';
        }
      } else if (type === 'task:complete') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          const errorText = d.error as string | undefined;
          task.status = errorText === 'Interrupted by user'
            ? 'interrupted'
            : (errorText && /terminated|aborted|interrupted/i.test(errorText))
              ? 'terminated'
              : errorText
                ? 'error'
                : 'done';
          task.finishedAt = new Date().toISOString();
          task.output = (d.output as string) ?? '';
          task.outputs = d.outputs as string[] | undefined;
          if (d.error) task.error = d.error as string;
        }
      } else if (type === 'complete') {
        run.status = 'done';
        run.finishedAt = new Date().toISOString();
      } else if (type === 'error') {
        const message = (d.message as string | undefined) ?? '';
        run.status = /terminated|aborted|interrupted/i.test(message) ? 'terminated' : 'error';
        run.finishedAt = new Date().toISOString();
        if (run.status === 'terminated') {
          for (const task of run.tasks) {
            if (task.status === 'running' || task.status === 'awaiting_review' || task.status === 'interrupted') {
              task.status = 'terminated';
              task.error = message || 'Run terminated by user';
              task.finishedAt = new Date().toISOString();
            } else if (task.status === 'pending') {
              task.status = 'skipped';
              task.error = undefined;
              task.finishedAt = new Date().toISOString();
            }
          }
        }
      } else if (type === 'review:pending') {
        const mode = (d.mode as string | undefined) ?? 'review';
        run.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          task.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
          task.currentRound = (d.round as number) ?? 1;
        }
      } else if (type === 'review:submitted') {
        run.status = 'running';
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          const mode = (d.mode as string | undefined) ?? 'review';
          if (!task.rounds) task.rounds = [];
          const round = (d.round as number) ?? (task.rounds.length + 1);
          task.rounds = [
            ...task.rounds,
            {
              round,
              output: task.output ?? '',
              toolEvents: task.toolEvents,
              finishedAt: new Date().toISOString(),
              review: {
                action: (d.action as 'approve' | 'revise'),
                comment: (d.comment as string | undefined) ?? '',
                targetTaskId: d.targetTaskId as string | undefined,
                agentId: d.agentId as string | undefined,
                reviewedAt: new Date().toISOString(),
              },
            },
          ];
          task.status = mode === 'interrupt'
            ? 'running'
            : (d.action as string) === 'approve' ? 'done' : 'pending';
          if (mode === 'interrupt') task.error = undefined;
        }
      } else if (type === 'task:revision') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          task.status = 'running';
          task.currentRound = (d.round as number) ?? 2;
          task.output = '';
          task.outputs = undefined;
          task.toolEvents = [];
          task.workerStatus = task.agents.length > 1 ? task.agents.map(() => 'running') : undefined;
          task.error = undefined;
        }
      }

      return run;
    });

    // Refresh list when run completes
    if (type === 'complete' || type === 'error') {
      load(true);
    }
  }, [load]);

  // Polling for the run list + selected run refresh
  useEffect(() => {
    const poll = async () => {
      await load(true);
      // Only poll run detail if not subscribed via SSE
      if (selectedId && !sseRef.current) {
        try {
          const detail = await api.getRun(selectedId);
          setSelectedRun(detail);
        } catch { /* silent */ }
      }
    };

    const interval = window.setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [selectedId, load]);

  // Load selected run detail + subscribe to SSE if running
  useEffect(() => {
    if (!selectedId) return;

    // Clean up previous SSE subscription
    sseRef.current?.abort();
    sseRef.current = null;

    setLoadingDetail(true);
    api.getRun(selectedId)
      .then((run) => {
        setSelectedRun(run);
        // If the run is still active or waiting for input, subscribe to SSE for live updates
        if (run.status === 'running' || run.status === 'awaiting_review' || run.status === 'interrupted') {
          sseRef.current = api.subscribeRun(selectedId, applyRunEvent);
        }
      })
      .catch(() => setSelectedRun(null))
      .finally(() => setLoadingDetail(false));

    return () => {
      sseRef.current?.abort();
      sseRef.current = null;
    };
  }, [selectedId, applyRunEvent]);

  return (
    <div className="flex h-[calc(100vh-48px)] bg-zinc-50">
      {/* Left: run list */}
      <div className="w-72 shrink-0 flex flex-col border-r border-zinc-200 bg-white">
        <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">
            {t('runs.heading', 'Run History')}
          </h2>
          <button
            onClick={() => load()}
            className="text-zinc-400 hover:text-zinc-600 transition-colors"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-5">
              <div className="text-3xl mb-3 opacity-20">▶</div>
              <p className="text-xs text-zinc-400">{t('runs.empty', 'No runs yet. Execute a pipeline to see history here.')}</p>
            </div>
          ) : (
            buildGroupedRunList(runs.filter(r => !r.continuedFromRunId), collapsedPipelines, collapsedRuns).map((item) => {
              if (item.type === 'group') {
                return (
                  <div
                    key={`g-${item.pipelineId}`}
                    className="group flex items-center gap-1.5 px-3 py-1.5 bg-zinc-50 border-b border-zinc-100 cursor-pointer hover:bg-zinc-100/60 select-none sticky top-0 z-10"
                    onClick={() => togglePipelineCollapse(item.pipelineId)}
                  >
                    <svg
                      className={`w-3 h-3 text-zinc-400 transition-transform shrink-0 ${item.isCollapsed ? '' : 'rotate-90'}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-[11px] font-semibold text-zinc-500 truncate flex-1">{item.pipelineName}</span>
                    <span className="text-[10px] text-zinc-300 shrink-0">{item.runCount}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeletePipelineRuns(item.pipelineId, item.pipelineName);
                      }}
                      className="shrink-0 rounded p-1 text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100"
                      title={`删除「${item.pipelineName}」下所有运行记录`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                );
              }
              const { run, depth, hasChild, collapsed } = item;
              return (
                <div key={run.id} className="flex items-stretch border-b border-zinc-100/50">
                  {depth > 0 && (
                    <div className="flex shrink-0 self-stretch w-6 justify-center relative select-none">
                      {/* A continuous timeline vertical line */}
                      <div className="absolute top-0 bottom-0 left-[11px] border-l-2 border-zinc-200" />
                      {/* Timeline dot node */}
                      <div className={`absolute top-[16px] left-[8px] w-2.5 h-2.5 rounded-full border-2 border-white ring-1 transition-all ${
                        selectedId === run.id
                          ? 'bg-indigo-500 ring-indigo-200 scale-110 shadow-sm'
                          : 'bg-zinc-300 ring-zinc-100'
                      }`} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <RunCard
                      run={run}
                      selected={selectedId === run.id || getRootRunId(selectedId, runs) === run.id}
                      onDelete={() => handleDeleteRun(run.id)}
                      onClick={() => setSelectedId(run.id)}
                      hasChild={hasChild}
                      collapsed={collapsed}
                      onToggleCollapse={() => toggleCollapse(run.id)}
                      isChild={depth > 0}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: run detail */}
      <div className="flex-1 overflow-hidden bg-white">
        {loadingDetail ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : selectedRun ? (
          <RunDetail
            run={selectedRun}
            agents={agents}
            pipelines={pipelines}
            runs={runs}
            onReviewSubmitted={() => {
              // Refresh the run detail after review submission
              if (selectedId) {
                api.getRun(selectedId).then(setSelectedRun).catch(() => {});
              }
            }}
            onContinueStarted={(newRunId) => {
              setSelectedId(newRunId);
              load(true);
            }}
            onInterruptTask={handleInterruptTask}
            onSelectTask={handleSelectTask}
            onSelectRun={handleSelectRun}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="text-4xl mb-4 opacity-20">🔍</div>
            <p className="text-sm font-medium text-zinc-400">{t('runs.selectRun', 'Select a run to view details')}</p>
            <p className="text-xs text-zinc-300 mt-1">
              {t('runs.streamJsonTip', 'Tip: use --output-format stream-json in CLI agents to capture tool calls')}
            </p>
          </div>
        )}
      </div>

      {/* Task Drawer Popup for Map and Timeline clicks */}
      {activeTaskSelection && (
        (() => {
          const runForDialog = (
            activeTaskSelection.runSnapshot && activeTaskSelection.runSnapshot.id === activeTaskSelection.runId
              ? activeTaskSelection.runSnapshot
              : (selectedRun && selectedRun.id === activeTaskSelection.runId ? selectedRun : null)
          );

          const task = (
            activeTaskSelection.taskSnapshot
            && activeTaskSelection.taskSnapshot.taskId === activeTaskSelection.taskId
            && runForDialog
            && runForDialog.id === activeTaskSelection.runId
          )
            ? activeTaskSelection.taskSnapshot
            : runForDialog?.tasks.find((t) => t.taskId === activeTaskSelection.taskId);

          return task ? (
            <TaskDetailDialog
              task={task}
              run={runForDialog as RunRecord}
              agents={agents}
              onContinueStarted={(newRunId) => {
                setSelectedId(newRunId);
                load(true);
              }}
              onClose={() => setActiveTaskSelection(null)}
              onInterrupt={handleInterruptTask ? () => handleInterruptTask(task.taskId) : undefined}
              onReviewSubmitted={() => {
                // Refresh the run detail after review submission
                if (selectedId) {
                  api.getRun(selectedId).then(setSelectedRun).catch(() => {});
                }
              }}
            />
          ) : (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-500 shadow-sm">
                正在加载任务详情...
              </div>
            </div>
          );
        })()
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none">
      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M12 7A5 5 0 0 1 2 7a5 5 0 0 1 8.66-2.5L12 5V2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin text-zinc-400" width="16" height="16" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.2" />
      <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
