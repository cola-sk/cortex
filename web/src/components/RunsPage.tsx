import { useState, useEffect, useCallback, useRef } from 'react';
import type { RunSummary, RunRecord, RunTaskRecord, RunEventType, ToolEvent } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { TaskDetailShared, MarkdownWithThinking, type DetailStatus } from './TaskDetailShared';

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

function statusColors(status: string) {
  if (status === 'done') return 'bg-emerald-100 text-emerald-700';
  if (status === 'error') return 'bg-red-100 text-red-600';
  if (status === 'awaiting_review') return 'bg-amber-100 text-amber-700';
  if (status === 'interrupted') return 'bg-zinc-100 text-zinc-700';
  return 'bg-blue-100 text-blue-600';
}

function statusDot(status: string) {
  if (status === 'done') return 'bg-emerald-400';
  if (status === 'error') return 'bg-red-400';
  if (status === 'awaiting_review') return 'bg-amber-400 animate-pulse';
  if (status === 'interrupted') return 'bg-zinc-400';
  return 'bg-blue-400 animate-pulse';
}

function statusLabel(status: RunSummary['status'] | RunTaskRecord['status']): string {
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'error') return 'error';
  if (status === 'awaiting_review') return 'awaiting_input';
  if (status === 'interrupted') return 'interrupted';
  return status;
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

function TaskDetailPanel({ task, fullHeight = false }: { task: RunTaskRecord; fullHeight?: boolean }) {
  const status: DetailStatus =
    task.status === 'pending'
      ? 'running'
      : task.status === 'awaiting_review'
        ? 'running'
        : task.status;
  const output = task.output ?? '';
  const detail = task.error ?? '';
  // Preserve full execution detail after completion as well.
  const detailEventMode = 'all';

  return (
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
    />
  );
}

function TaskDetailDialog({ task, onClose }: { task: RunTaskRecord; onClose: () => void }) {
  const toolCallCount = (task.toolEvents ?? []).flat().filter((e) => e.type === 'tool_use').length;

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

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
              {task.status === 'running' && <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20">● Running</span>}
              {task.status === 'interrupted' && <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300">■ Interrupted</span>}
              {task.status === 'error' && <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">✗ Error</span>}
            </div>
            <div className="flex items-center flex-wrap gap-3 mt-1.5 text-xs text-zinc-500">
              {task.durationMs != null && <span className="flex items-center gap-1">⏱ {formatDuration(task.durationMs)}</span>}
              {toolCallCount > 0 && <span className="flex items-center gap-1">🔧 {toolCallCount} tool calls</span>}
              <span className="flex items-center gap-1">👥 {task.agents.join(', ')}</span>
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

        <div className="flex-1 overflow-y-auto px-1.5 py-1">
          <TaskDetailPanel task={task} fullHeight />
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task record row
// ─────────────────────────────────────────────────────────────────────────────

function TaskRow({ task, onInterrupt }: { task: RunTaskRecord; onInterrupt?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  
  const allToolEvents = (task.toolEvents ?? []).flat();
  const toolCallCount = allToolEvents.filter((e) => e.type === 'tool_use').length;

  return (
    <>
    <div className={`rounded-xl border overflow-hidden transition-all ${
      task.status === 'error' ? 'border-red-200' : task.status === 'interrupted' ? 'border-zinc-300' : 'border-zinc-200'
    }`}>
      <div className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-zinc-50 transition-colors text-left">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex-1 min-w-0 flex items-center gap-3 text-left"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(task.status)}`} />
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
              title="中断任务"
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
          <TaskDetailPanel task={task} />
        </div>
      )}
    </div>
    {showModal && <TaskDetailDialog task={task} onClose={() => setShowModal(false)} />}
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

function Markdown({ content, className }: { content: string; className?: string }) {
  return <MarkdownWithThinking content={content} className={className} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run detail panel
// ─────────────────────────────────────────────────────────────────────────────

function RunDetailReviewPanel({ runId, task, onSubmitted }: {
  runId: string;
  task: RunTaskRecord;
  onSubmitted: () => void;
}) {
  const [comment, setComment] = useState('');
  const [action, setAction] = useState<'approve' | 'revise'>(task.status === 'interrupted' ? 'revise' : 'approve');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isInterrupted = task.status === 'interrupted';

  const handleSubmit = async () => {
    if ((isInterrupted || action === 'revise') && !comment.trim()) {
      setError(isInterrupted ? '请填写评论后继续执行。' : 'Please provide feedback when requesting a revision.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.submitReview(
        runId,
        task.taskId,
        isInterrupted ? 'revise' : action,
        comment.trim(),
        isInterrupted ? task.taskId : undefined,
      );
      onSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
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
          <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-50 p-3 text-xs">
            <Markdown content={task.output} />
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
          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize-none"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={isInterrupted ? '请输入本次中断原因或补充说明，然后继续执行...' : (action === 'approve' ? 'Optional comment...' : 'Describe what needs to change...')}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end">
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
  );
}

function RunDetail({ run, onReviewSubmitted, onInterruptTask }: { run: RunRecord; onReviewSubmitted: () => void; onInterruptTask?: (taskId: string) => void }) {
  const awaitingTask = run.tasks.find((t) => t.status === 'awaiting_review' || t.status === 'interrupted');

  return (
    <div className="h-full overflow-y-auto">
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

      {/* Review panel for awaiting task */}
      {awaitingTask && (
        <div className="px-5 py-4">
          <RunDetailReviewPanel
            runId={run.id}
            task={awaitingTask}
            onSubmitted={onReviewSubmitted}
          />
        </div>
      )}

      {/* Tasks */}
      <div className="px-5 py-4 space-y-3">
        {run.tasks.map((task) => (
          <TaskRow key={task.taskId} task={task} onInterrupt={onInterruptTask ? () => onInterruptTask(task.taskId) : undefined} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Run list card
// ─────────────────────────────────────────────────────────────────────────────

function RunCard({ run, selected, onClick }: {
  run: RunSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex flex-col gap-1 px-4 py-3 text-left border-b border-zinc-100 hover:bg-zinc-50 transition-colors ${
        selected ? 'bg-indigo-50 border-l-2 border-l-indigo-400' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-700 truncate flex-1">{run.pipelineName}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors(run.status)}`}>
          {statusLabel(run.status)}
        </span>
      </div>
      <p className="text-xs text-zinc-400 truncate leading-snug">{run.goal}</p>
      <div className="flex items-center gap-2 text-[10px] text-zinc-300 mt-0.5">
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
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RunsPage
// ─────────────────────────────────────────────────────────────────────────────

export function RunsPage() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const sseRef = useRef<{ abort: () => void } | null>(null);

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

  const handleInterruptTask = async (taskId: string) => {
    if (!selectedId) return;
    try {
      await api.interruptTask(selectedId, taskId);
      const detail = await api.getRun(selectedId);
      setSelectedRun(detail);
    } catch (e) {
      console.error('Failed to interrupt task:', e);
      alert('Failed to interrupt task: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => { load(); }, [load]);

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
        if (task) { task.status = 'running'; task.startedAt = new Date().toISOString(); }
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
          task.status = (d.error as string | undefined) === 'Interrupted by user'
            ? 'interrupted'
            : d.error ? 'error' : 'done';
          task.finishedAt = new Date().toISOString();
          task.output = (d.output as string) ?? '';
          task.outputs = d.outputs as string[] | undefined;
          if (d.error) task.error = d.error as string;
        }
      } else if (type === 'complete') {
        run.status = 'done';
        run.finishedAt = new Date().toISOString();
      } else if (type === 'error') {
        run.status = 'error';
        run.finishedAt = new Date().toISOString();
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
          task.status = mode === 'interrupt'
            ? 'running'
            : (d.action as string) === 'approve' ? 'done' : 'running';
          if (mode === 'interrupt') task.error = undefined;
        }
      } else if (type === 'task:revision') {
        const task = run.tasks.find((t) => t.taskId === d.taskId);
        if (task) {
          task.status = 'running';
          task.currentRound = (d.round as number) ?? 2;
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
            onClick={load}
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
            runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                selected={selectedId === run.id}
                onClick={() => setSelectedId(run.id)}
              />
            ))
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
            onReviewSubmitted={() => {
              // Refresh the run detail after review submission
              if (selectedId) {
                api.getRun(selectedId).then(setSelectedRun).catch(() => {});
              }
            }}
            onInterruptTask={handleInterruptTask}
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
