import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunSummary, RunRecord, RunTaskRecord, ToolEvent } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { TaskDetailModal, type LogEntry } from './PipelinePage';

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
  return 'bg-blue-100 text-blue-600';
}

function statusDot(status: string) {
  if (status === 'done') return 'bg-emerald-400';
  if (status === 'error') return 'bg-red-400';
  return 'bg-blue-400 animate-pulse';
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

function ToolEventPair({ use, result, index }: {
  use: ToolEvent;
  result?: ToolEvent;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(use);

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
            <pre className="text-xs text-zinc-600 whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto bg-zinc-50 rounded p-2">
              {summary || JSON.stringify(use.input, null, 2)}
            </pre>
          </div>
          {/* Output */}
          {result && (
            <div className="px-3 py-2">
              <p className={`text-[10px] font-medium uppercase tracking-wider mb-1 ${result.isError ? 'text-red-400' : 'text-zinc-400'}`}>
                Output{result.isError ? ' (error)' : ''}
              </p>
              <pre className={`text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto rounded p-2 ${result.isError ? 'bg-red-50 text-red-700' : 'bg-zinc-50 text-zinc-600'}`}>
                {result.content || '(empty)'}
              </pre>
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
        last.content += '\\n' + (ev.content ?? '');
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

// ─────────────────────────────────────────────────────────────────────────────
// Task record row
// ─────────────────────────────────────────────────────────────────────────────

function TaskRow({ task, run }: { task: RunTaskRecord; run: RunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  
  const allToolEvents = (task.toolEvents ?? []).flat();
  const toolCallCount = allToolEvents.filter((e) => e.type === 'tool_use').length;
  const hasMultiWorker = (task.toolEvents ?? []).length > 1;

  // Adapt RunTaskRecord into what TaskDetailModal expects
  const modalEntry: LogEntry = {
    id: task.taskId,
    type: 'task:complete' as any,
    label: task.taskName,
    status: task.status === 'error' ? 'error' : 'done',
    agents: task.agents,
    detail: task.error || task.output,
    toolEvents: allToolEvents,
    workerEvents: task.toolEvents,
    startedAt: new Date(run.startedAt).getTime(), // Approximated
    finishedAt: task.durationMs ? new Date(run.startedAt).getTime() + task.durationMs : undefined
  };

  return (
    <>
    <div className={`rounded-xl border overflow-hidden transition-all ${
      task.status === 'error' ? 'border-red-200' : 'border-zinc-200'
    }`}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-zinc-50 transition-colors text-left"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(task.status)}`} />
        <span className="flex-1 text-sm font-semibold text-zinc-800">{task.taskName}</span>
        <div className="flex items-center gap-2 shrink-0">
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
          <ChevronIcon className={`w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 px-4 py-3 bg-white space-y-3">
          <div className="flex justify-between items-center mb-2">
             <span className="text-xs font-semibold text-zinc-500">Details</span>
             <button 
               onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
               className="text-xs text-indigo-600 font-medium hover:text-indigo-800 hover:underline"
             >
               ↗ Open detail
             </button>
          </div>
          {/* Multi-worker breakdown */}
          {hasMultiWorker ? (
            (task.toolEvents ?? []).map((workerEvents, wi) => (
              <div key={wi} className="space-y-2">
                <p className="text-xs font-medium text-zinc-500">Worker {wi + 1} — {task.agents[wi] ?? task.agents[0]}</p>
                <ToolEventList events={workerEvents} />
              </div>
            ))
          ) : (
            allToolEvents.length > 0 && <ToolEventList events={allToolEvents} />
          )}

          {/* Output */}
          {task.output && (
            <div>
              <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Output</p>
              <div className={`text-xs whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto rounded-lg p-3 ${
                task.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-zinc-50'
              }`}>
                {task.error ? <pre className="font-mono text-red-700">{task.error}\n\n{task.output}</pre> : <Markdown content={task.output} />}
              </div>
            </div>
          )}
          {task.error && !task.output && (
            <pre className="text-xs text-red-600 bg-red-50 rounded-lg p-3 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {task.error}
            </pre>
          )}
        </div>
      )}
    </div>
    {showModal && <TaskDetailModal entry={modalEntry} onClose={() => setShowModal(false)} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown renderer (shared)
// ─────────────────────────────────────────────────────────────────────────────

function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={`prose prose-xs max-w-none text-zinc-700 leading-relaxed
      prose-headings:text-zinc-800 prose-headings:font-semibold
      prose-code:bg-zinc-100 prose-code:text-zinc-700 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px]
      prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-pre:rounded-lg prose-pre:text-xs prose-pre:overflow-x-auto
      prose-a:text-indigo-600 prose-blockquote:border-l-indigo-300 prose-blockquote:text-zinc-500
      prose-table:text-xs prose-th:bg-zinc-50 prose-td:py-1
      ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Run detail panel
// ─────────────────────────────────────────────────────────────────────────────

function RunDetail({ run }: { run: RunRecord }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-5 py-5 border-b border-zinc-100">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-zinc-400">{run.pipelineId}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColors(run.status)}`}>
                {run.status}
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

      {/* Tasks */}
      <div className="px-5 py-4 space-y-3">
        {run.tasks.map((task) => (
          <TaskRow key={task.taskId} task={task} run={run} />
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
          {run.status}
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

  useEffect(() => { load(); }, [load]);

  // Handle polling for the selected run and the overall list
  useEffect(() => {
    let interval: number;

    const poll = async () => {
      // Refresh the list silently
      await load(true);
      
      // If a run is selected, refresh its details
      if (selectedId) {
        try {
          const detail = await api.getRun(selectedId);
          setSelectedRun(detail);
        } catch { /* silent */ }
      }
    };

    // Only poll constantly, or poll if something is running.
    // For simplicity, we just poll every 2.5s since it's a local dev tool
    interval = window.setInterval(poll, 2500);

    return () => clearInterval(interval);
  }, [selectedId, load]);

  useEffect(() => {
    if (!selectedId) return;
    setLoadingDetail(true);
    api.getRun(selectedId)
      .then(setSelectedRun)
      .catch(() => setSelectedRun(null))
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

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
          <RunDetail run={selectedRun} />
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
