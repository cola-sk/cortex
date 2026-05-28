import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, RunSummary, RunRecord, RunTaskRecord, RunEventType, ToolEvent, Pipeline, ReviewRecord, RoundRecord } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { TaskDetailShared, MarkdownWithThinking, type DetailStatus, formatAgentInfo, getBaseAgentId } from './TaskDetailShared';

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
    const latestA = Math.max(...a[1].runs.map(r => new Date(r.startedAt).getTime()));
    const latestB = Math.max(...b[1].runs.map(r => new Date(r.startedAt).getTime()));
    return latestB - latestA;
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
    rootRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

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

function TaskDetailPanel({ task, agents, fullHeight = false }: { task: RunTaskRecord; agents: Agent[]; fullHeight?: boolean }) {
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
      <TaskRoundHistory task={task} agents={agents} />
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

function TaskRoundHistory({ task, agents }: { task: RunTaskRecord; agents: Agent[] }) {
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
          const roundAgentInfo = task.agents && task.agents.length > 0
            ? task.agents.map(aId => {
                const baseId = getBaseAgentId(aId, agents);
                return formatAgentInfo(baseId, agents);
              }).join(', ')
            : '';

          return (
            <details key={round.round} className="group rounded-xl border border-zinc-200/60 bg-white p-3 shadow-sm hover:shadow-md hover:border-zinc-300 transition-all">
              <summary className="cursor-pointer select-none text-xs text-zinc-700 font-bold flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold select-none ${
                  isRevise 
                    ? 'bg-amber-50 border border-amber-200 text-amber-700' 
                    : 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                }`}>
                  R{round.round}
                </span>
                <span className="font-semibold text-zinc-800">
                  {isRevise ? '↺ Revised' : '✓ Reviewed'}
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
}: {
  task: RunTaskRecord;
  onClose: () => void;
  run?: RunRecord;
  agents?: Agent[];
  onContinueStarted?: (newRunId: string) => void;
  onInterrupt?: () => void;
}) {
  const toolCallCount = (task.toolEvents ?? []).flat().filter((e) => e.type === 'tool_use').length;

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const showContinuePanel = run && agents && onContinueStarted && (task.status === 'error' || task.status === 'interrupted' || task.status === 'terminated');

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
          <TaskDetailPanel task={task} agents={agents} fullHeight />
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
}: {
  task: RunTaskRecord;
  run?: RunRecord;
  agents?: Agent[];
  onContinueStarted?: (newRunId: string) => void;
  onInterrupt?: () => void;
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
          <TaskDetailPanel task={task} agents={agents} />
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
  onSelectTask: (taskId: string) => void;
  onInterruptTask?: (taskId: string) => void;
  onContinueStarted?: (newRunId: string) => void;
}

function WorkflowDAGMap({ run, pipelines, agents, onSelectTask, onInterruptTask, onContinueStarted }: WorkflowDAGMapProps) {
  const [branchTask, setBranchTask] = useState<RunTaskRecord | null>(null);
  const [reRunTask, setReRunTask] = useState<RunTaskRecord | null>(null);
  const pipeline = pipelines.find((p) => p.id === run.pipelineId);
  const getDeps = useCallback((taskId: string) => {
    return pipeline?.tasks.find((t) => t.id === taskId)?.dependsOn || [];
  }, [pipeline]);

  const levelGroups = calculateLevels(run.tasks, getDeps);

  return (
    <>
    <div className="p-6 bg-zinc-50/50 min-h-[400px] flex flex-col items-center">
      <div className="w-full max-w-2xl space-y-4">
        {levelGroups.map((group, gIdx) => (
          <div key={group.level} className="flex flex-col items-center">
            {/* Horizontal Row of Tasks in this dependency level */}
            <div className="flex flex-wrap justify-center gap-4 w-full">
              {group.tasks.map((task) => {
                const isSkippedDueToFailure = task.error === 'Skipped due to previous task failure';
                const isAwaiting = task.status === 'awaiting_review' || task.status === 'interrupted';
                const isRunning = task.status === 'running';
                const isDone = task.status === 'done';
                const isError = task.status === 'error' && !isSkippedDueToFailure;
                const isTerminated = task.status === 'terminated';
                const isSkipped = task.status === 'skipped' || isSkippedDueToFailure;
                const isPending = task.status === 'pending';

                let bgClass = 'bg-white/80 border-zinc-200 text-zinc-800';
                let statusDotClass = 'bg-zinc-400';
                let pulseClass = '';

                if (isDone) {
                  bgClass = 'bg-emerald-50/70 border-emerald-200 text-emerald-950 shadow-emerald-50/50';
                  statusDotClass = 'bg-emerald-500';
                } else if (isRunning) {
                  bgClass = 'bg-blue-50/70 border-blue-400 text-blue-950 shadow-blue-50/50 ring-2 ring-blue-100 animate-pulse';
                  statusDotClass = 'bg-blue-500 animate-ping';
                  pulseClass = 'animate-pulse';
                } else if (isAwaiting) {
                  bgClass = 'bg-amber-50/80 border-amber-400 text-amber-950 shadow-amber-50/50 ring-2 ring-amber-100';
                  statusDotClass = 'bg-amber-500 animate-pulse';
                } else if (isError) {
                  bgClass = 'bg-red-50/80 border-red-300 text-red-950 shadow-red-50/50 ring-2 ring-red-100';
                  statusDotClass = 'bg-red-500';
                } else if (isTerminated) {
                  bgClass = 'bg-zinc-100/80 border-zinc-300 text-zinc-800 shadow-zinc-100/70 ring-1 ring-zinc-200';
                  statusDotClass = 'bg-zinc-500';
                } else if (isSkipped) {
                  bgClass = 'bg-zinc-50/80 border-zinc-200 text-zinc-500';
                  statusDotClass = 'bg-zinc-300';
                } else if (isPending) {
                  bgClass = 'bg-zinc-50/50 border-zinc-200/60 text-zinc-400';
                  statusDotClass = 'bg-zinc-300';
                }

                return (
                  <div
                    key={task.taskId}
                    onClick={() => onSelectTask(task.taskId)}
                    className={`flex-1 min-w-[240px] max-w-[320px] rounded-xl border p-4 shadow-sm hover:shadow-md cursor-pointer transition-all hover:-translate-y-0.5 backdrop-blur-sm ${bgClass}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDotClass}`} />
                      <span className={`text-xs font-bold leading-tight flex-1 min-w-0 truncate ${pulseClass}`} title={task.taskName}>
                        {task.taskName}
                      </span>
                      {task.status !== 'pending' && (
                        <div className="ml-auto flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          {isRunning && onInterruptTask && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm("确定要终止该任务的执行吗？")) {
                                  onInterruptTask(task.taskId);
                                }
                              }}
                              className="flex items-center justify-center gap-1 rounded bg-red-50 hover:bg-red-100 border border-red-200 hover:border-red-300 px-1.5 py-0.5 text-[9px] font-bold text-red-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                                title="终止任务"
                            >
                              <span className="w-1.5 h-1.5 bg-red-500 rounded-[1px] animate-pulse" />
                              <span>终止</span>
                            </button>
                          )}
                          {isDone && onContinueStarted && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setBranchTask(task); }}
                              className="flex items-center justify-center rounded bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 hover:border-emerald-300 p-0.5 text-emerald-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                              title="从此任务创建分支"
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 2 L4 8" />
                                <path d="M4 8 L4 14" />
                                <path d="M4 5 Q4 5 10 5 L10 14" />
                                <path d="M8 12 L10 14 L12 12" />
                                <path d="M2 12 L4 14 L6 12" />
                              </svg>
                            </button>
                          )}
                          {(isError || isTerminated || task.status === 'interrupted') && onContinueStarted && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setReRunTask(task); }}
                              className="flex items-center justify-center rounded bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 hover:border-indigo-300 p-0.5 text-indigo-600 transition-colors shadow-sm cursor-pointer active:scale-95"
                              title="重跑当前失败任务"
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1.5 8a6.5 6.5 0 1 0 1.5-4.2L1.5 6" />
                                <path d="M1.5 1.5v4.5h4.5" />
                              </svg>
                            </button>
                          )}
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                            isDone ? 'bg-emerald-100/60 text-emerald-700' :
                            isRunning ? 'bg-blue-100/60 text-blue-700' :
                            isAwaiting ? 'bg-amber-100/60 text-amber-700' :
                            isTerminated ? 'bg-zinc-200/70 text-zinc-700' :
                            isSkipped ? 'bg-zinc-100 text-zinc-500' :
                            isError ? 'bg-red-100/60 text-red-700' :
                            'bg-zinc-100 text-zinc-600'
                          }`}>
                            {isSkippedDueToFailure ? 'skipped' : statusLabel(task.status)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className="font-mono">🤖 {task.agents.map(aId => {
                        const ag = agents.find(a => a.id === aId);
                        return ag?.name || aId;
                      }).join(', ')}</span>
                      {task.durationMs != null && (
                        <>
                          <span>·</span>
                          <span>⏱ {formatDuration(task.durationMs)}</span>
                        </>
                      )}
                    </div>

                    {/* Rounds sequence visual with hover tooltips */}
                    {task.rounds && task.rounds.length > 0 && (
                      <div className="mt-3 border-t border-zinc-100/60 pt-2 flex flex-wrap gap-1.5 items-center">
                        <span className="text-[9px] uppercase tracking-wider text-zinc-400/80 font-bold mr-1">Rounds:</span>
                        {task.rounds.map((r) => (
                          <div
                            key={r.round}
                            className={`group relative rounded px-1.5 py-0.5 text-[10px] font-semibold border flex items-center gap-0.5 transition-all hover:scale-105 select-none ${
                              r.review?.action === 'revise'
                                ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100 hover:border-amber-300'
                                : 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300'
                            }`}
                          >
                            <span>R{r.round}</span>
                            {r.review?.comment && <span className="text-[8px]">💬</span>}

                            {/* Floating review summary */}
                            {r.review?.comment && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-[99] w-52 rounded-xl bg-zinc-950 text-white p-3 text-[10px] leading-relaxed shadow-xl border border-zinc-800 backdrop-blur-sm pointer-events-none transition-opacity">
                                <div className="font-bold border-b border-white/10 pb-1 mb-1 flex justify-between items-center text-zinc-300">
                                  <span>{r.review.action === 'revise' ? '↺ Revision' : '✓ Approved'}</span>
                                  <span className="text-zinc-500 font-normal font-mono">{formatTime(r.review.reviewedAt)}</span>
                                </div>
                                <p className="italic text-zinc-200 font-medium">"{r.review.comment}"</p>
                              </div>
                            )}
                          </div>
                        ))}

                        {/* Current round if in progress or waiting */}
                        {(isRunning || isAwaiting) && (
                          <span className="rounded bg-indigo-50 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 text-[10px] font-semibold animate-pulse">
                            R{task.currentRound ?? (task.rounds.length + 1)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* SVG arrows between rows */}
            {gIdx < levelGroups.length - 1 && (
              <div className="my-3 flex justify-center text-zinc-300/80">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="animate-bounce">
                  <path d="M12 4v16M12 20l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>

      {/* Branch modal */}
      {branchTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setBranchTask(null)}
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
                onClick={() => setBranchTask(null)}
                className="text-emerald-500 hover:text-emerald-700 transition-colors p-1.5 rounded hover:bg-emerald-100/50 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <RunDetailBranchPanel
              run={run}
              agents={agents}
              task={branchTask!}
              hideHeader={true}
              onStarted={(newRunId) => {
                setBranchTask(null);
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
          onClick={() => setReRunTask(null)}
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
                onClick={() => setReRunTask(null)}
                className="text-indigo-500 hover:text-indigo-700 transition-colors p-1.5 rounded hover:bg-indigo-100/50 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <RunDetailContinuePanel
              run={run}
              agents={agents}
              task={reRunTask!}
              hideHeader={true}
              onStarted={(newRunId) => {
                setReRunTask(null);
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
  onSelectTask: (taskId: string) => void;
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
                      onClick={() => onSelectTask(item.task!.taskId)}
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
  onSelectTask: (taskId: string) => void;
  onSelectRun: (runId: string) => void;
}) {
  const awaitingTask = run.tasks.find((t) => t.status === 'awaiting_review' || t.status === 'interrupted');
  const [viewTab, setViewTab] = useState<'map' | 'timeline' | 'tasks'>('map');

  const parentRun = run.continuedFromRunId ? runs.find(r => r.id === run.continuedFromRunId) : null;
  const childRun = runs.find(r => r.continuedFromRunId === run.id);

  return (
    <div className="h-full overflow-y-auto">
      {/* Lineage Ribbon */}
      {(parentRun || childRun) && (
        <div className="bg-indigo-50/60 border-b border-indigo-100/50 px-5 py-2.5 flex items-center gap-3 text-xs select-none">
          <span className="text-indigo-600 font-bold uppercase tracking-wider text-[9px] bg-indigo-100 border border-indigo-200 px-1.5 py-0.5 rounded">
            Lineage Tree
          </span>
          {parentRun && (
            <button
              onClick={() => onSelectRun(parentRun.id)}
              className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 hover:underline font-semibold"
            >
              ← Continued from {parentRun.pipelineName} ({parentRun.id.slice(-6)})
            </button>
          )}
          {parentRun && childRun && <span className="text-indigo-200 font-bold">·</span>}
          {childRun && (
            <button
              onClick={() => onSelectRun(childRun.id)}
              className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 hover:underline font-semibold"
            >
              Continued as next branch ({childRun.id.slice(-6)}) →
            </button>
          )}
        </div>
      )}

      <div className="px-5 py-5 border-b border-zinc-100">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-zinc-400">{run.pipelineId}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColors(run.status)}`}>
                {statusLabel(run.status)}
              </span>
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
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span>⏱ {formatDuration(run.durationMs)}</span>
          <span>📋 {run.taskCount} task{run.taskCount !== 1 ? 's' : ''}</span>
          {run.toolCallCount > 0 && <span>🔧 {run.toolCallCount} tool call{run.toolCallCount !== 1 ? 's' : ''}</span>}
          <span className="text-zinc-300 font-mono text-[10px]">{run.id}</span>
        </div>
      </div>

      {/* Tabs list styled for high aesthetics */}
      <div className="flex border-b border-zinc-200 bg-zinc-50/50 px-5">
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
      {viewTab === 'map' && (
        <WorkflowDAGMap
          run={run}
          pipelines={pipelines}
          agents={agents}
          onSelectTask={onSelectTask}
          onInterruptTask={onInterruptTask}
          onContinueStarted={onContinueStarted}
        />
      )}

      {viewTab === 'timeline' && (
        <ChronologicalTimeline
          run={run}
          onSelectTask={onSelectTask}
        />
      )}

      {viewTab === 'tasks' && (
        <div className="px-5 py-4 space-y-3">
          {run.tasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              run={run}
              agents={agents}
              onContinueStarted={onContinueStarted}
              onInterrupt={onInterruptTask ? () => onInterruptTask(task.taskId) : undefined}
            />
          ))}
        </div>
      )}

      {/* Action panel: place below history/task entries */}
      {awaitingTask && (
        <div className="px-5 pb-4 pt-2 border-t border-zinc-100">
          <RunDetailReviewPanel
            runId={run.id}
            run={run}
            task={awaitingTask}
            agents={agents}
            onSubmitted={onReviewSubmitted}
          />
        </div>
      )}

      {!awaitingTask && (run.status === 'error' || run.status === 'terminated') && (
        <div className="px-5 pb-4 pt-2 border-t border-zinc-100">
          <RunDetailContinuePanel
            run={run}
            agents={agents}
            onStarted={onContinueStarted}
          />
        </div>
      )}
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
        selected ? 'bg-indigo-50/50 border-l-2 border-l-indigo-400' : 'border-l-2 border-l-transparent'
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
          isChild ? 'text-zinc-500' : 'text-zinc-700 font-medium'
        }`}>{run.goal}</p>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors(run.status)}`}>
          {statusLabel(run.status)}
        </span>
      </div>
      {/* Line 2: type badge (if any) + time info */}
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-300 pl-6">
        {run.continuationType && (
          <span className={`shrink-0 inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold ${
            run.continuationType === 'branch'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              : 'bg-indigo-50 border border-indigo-200 text-indigo-700'
          }`}>
            {run.continuationType === 'branch' ? '🌱 分支' : '↻ 重跑'}
            {run.continuationTaskName ? `: ${run.continuationTaskName} (R${run.continuationRound})` : ''}
          </span>
        )}
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

      {/* Delete button (visible on hover) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm('Are you sure you want to delete this run record?')) {
            onDelete();
          }
        }}
        className="absolute right-1.5 top-1.5 text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all p-1 rounded hover:bg-red-50"
        title="Delete run"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RunsPage
// ─────────────────────────────────────────────────────────────────────────────

export function RunsPage() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      // Auto-select most recent run
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id);
      }
    } catch { /* silent */ } finally {
      if (!silent) setLoading(false);
    }
  }, [selectedId]);

  const handleDeleteRun = useCallback(async (runId: string) => {
    try {
      const { success } = await api.deleteRun(runId);
      if (success) {
        if (selectedId === runId) {
          setSelectedId(null);
          setSelectedRun(null);
        }
        await load(true);
      }
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }, [selectedId, load]);

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
            buildGroupedRunList(runs, collapsedPipelines, collapsedRuns).map((item) => {
              if (item.type === 'group') {
                return (
                  <div
                    key={`g-${item.pipelineId}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-50 border-b border-zinc-100 cursor-pointer hover:bg-zinc-100/60 select-none sticky top-0 z-10"
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
                  </div>
                );
              }
              const { run, depth, hasChild, collapsed } = item;
              return (
                <div key={run.id} className="flex items-stretch border-b border-zinc-100/50">
                  {depth > 0 && (
                    <div className="flex shrink-0 self-stretch" style={{ width: `${depth * 14}px` }}>
                      {Array.from({ length: depth }).map((_, i) => (
                        <div key={i} className="w-[14px] shrink-0 flex justify-center self-stretch">
                          <div className="border-l-2 border-zinc-200 self-stretch" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <RunCard
                      run={run}
                      selected={selectedId === run.id}
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
            onSelectTask={(taskId) => setActiveTaskId(taskId)}
            onSelectRun={(runId) => setSelectedId(runId)}
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
      {activeTaskId && selectedRun && (
        (() => {
          const task = selectedRun.tasks.find(t => t.taskId === activeTaskId);
          return task ? (
            <TaskDetailDialog
              task={task}
              run={selectedRun}
              agents={agents}
              onContinueStarted={(newRunId) => {
                setSelectedId(newRunId);
                load(true);
              }}
              onClose={() => setActiveTaskId(null)}
              onInterrupt={handleInterruptTask ? () => handleInterruptTask(task.taskId) : undefined}
            />
          ) : null;
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
