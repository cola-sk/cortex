import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolEvent } from '../types';

export type DetailStatus = 'running' | 'done' | 'error' | 'decision';

type ContentSection = { kind: 'markdown' | 'thinking'; content: string };

type TimelineItem =
  | { type: 'tool'; use: ToolEvent; result?: ToolEvent; index: number }
  | { type: 'text'; content: string; index: number };

export interface TaskDetailSharedProps {
  workers: ToolEvent[][];
  agents?: string[];
  status: DetailStatus;
  detail?: string;
  output?: string;
  fullHeight?: boolean;
  detailEventMode?: 'all' | 'tools-only';
}

function normalizeMixedContent(input: string): string {
  let text = input.replace(/\r\n/g, '\n');
  const escapedNewlineCount = (text.match(/\\n/g) ?? []).length;
  const hasRealNewline = text.includes('\n');

  if (escapedNewlineCount > 0 && (!hasRealNewline || escapedNewlineCount >= 2)) {
    text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  return text;
}

function tryParseMaybeJson(text: string): unknown | undefined {
  let cur = text.trim();
  if (!cur) return undefined;

  for (let i = 0; i < 2; i += 1) {
    try {
      const parsed = JSON.parse(cur);
      if (typeof parsed === 'string') {
        cur = parsed;
        continue;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function formatJsonLikeText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const parsedLines = lines.map((line) => tryParseMaybeJson(line));
    if (parsedLines.every(Boolean)) {
      return parsedLines
        .map((obj) => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``)
        .join('\n\n');
    }
  }

  const parsed = tryParseMaybeJson(normalized);
  if (parsed && typeof parsed === 'object') {
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  }

  return null;
}

function prepareDisplayContent(input: string): string {
  const normalized = normalizeMixedContent(input);
  if (/<(thinking|think)>/i.test(normalized)) return normalized;
  return formatJsonLikeText(normalized) ?? normalized;
}

function splitThinkingSections(input: string): ContentSection[] {
  const content = prepareDisplayContent(input);
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

export function MarkdownWithThinking({ content, className }: { content: string; className?: string }) {
  const sections = splitThinkingSections(content);
  const proseClass = `prose prose-xs max-w-none text-zinc-700 leading-relaxed
      prose-headings:text-zinc-800 prose-headings:font-semibold
      prose-code:bg-zinc-100 prose-code:text-zinc-700 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px]
      prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-pre:rounded-lg prose-pre:text-xs prose-pre:overflow-x-auto
      prose-a:text-indigo-600 prose-blockquote:border-l-indigo-300 prose-blockquote:text-zinc-500
      prose-table:text-xs prose-th:bg-zinc-50 prose-td:py-1`;

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {sections.map((section, idx) => {
        if (section.kind === 'thinking') {
          return (
            <details key={`think-${idx}`} className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
              <summary className="cursor-pointer select-none text-[11px] font-semibold text-amber-700">Thinking</summary>
              <div className={`mt-2 ${proseClass} prose-amber text-amber-900`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
              </div>
            </details>
          );
        }

        return (
          <div key={`md-${idx}`} className={proseClass}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}

function getToolBadgeColor(name?: string): string {
  if (!name) return 'bg-zinc-100 text-zinc-600';
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('run')) return 'bg-zinc-800 text-white';
  if (n.includes('read') || n.includes('glob') || n.includes('ls') || n.includes('list') || n.includes('search') || n.includes('grep')) return 'bg-blue-100 text-blue-700';
  if (n.includes('write') || n.includes('edit') || n.includes('multi')) return 'bg-amber-100 text-amber-700';
  if (n.includes('web')) return 'bg-purple-100 text-purple-700';
  return 'bg-zinc-100 text-zinc-600';
}

function getToolSummaryText(event: ToolEvent): string {
  if (!event.input) return '';
  const inp = event.input;
  if (inp.command) return String(inp.command);
  if (inp.path) return String(inp.path);
  if (inp.file_path) return String(inp.file_path);
  if (inp.query) return String(inp.query);
  if (inp.pattern) return String(inp.pattern);
  return JSON.stringify(inp).slice(0, 120);
}

function appendTextChunk(base: string, chunk: string): string {
  if (!chunk) return base;
  if (!base) return chunk;
  if (base.endsWith('\n') || chunk.startsWith('\n')) return base + chunk;
  return `${base}\n${chunk}`;
}

function buildTimeline(events: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let idx = 0;
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === ev.toolUseId);
      items.push({ type: 'tool', use: ev, result, index: idx++ });
    } else if (ev.type === 'text') {
      const last = items[items.length - 1];
      if (last && last.type === 'text') {
        last.content = appendTextChunk(last.content, ev.content ?? '');
      } else {
        items.push({ type: 'text', content: ev.content ?? '', index: idx++ });
      }
    }
  }
  return items;
}

function TimelineToolItem({ item, idx }: { item: TimelineItem & { type: 'tool' }; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummaryText(item.use);
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center w-5 shrink-0">
        <div className="w-2 h-2 rounded-full bg-zinc-300 mt-2" />
        <div className="w-px flex-1 bg-zinc-100 mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <button onClick={() => setExpanded((e) => !e)} className="w-full flex items-center gap-2 py-1 text-left group">
          <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ${getToolBadgeColor(item.use.name)}`}>
            {item.use.name ?? 'Tool'}
          </span>
          <span className="text-xs font-mono text-zinc-500 truncate flex-1">{summary}</span>
          {item.result?.isError && <span className="shrink-0 rounded px-1 py-0.5 text-[10px] bg-red-100 text-red-600">error</span>}
          <span className="text-zinc-300 text-[10px] opacity-0 group-hover:opacity-100">#{idx + 1}</span>
          <ChevronRightIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded && (
          <div className="mt-1 space-y-2 pl-1">
            <div>
              <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Input</p>
              <pre className="text-xs text-zinc-600 whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto bg-zinc-50 rounded p-2">
                {summary || JSON.stringify(item.use.input, null, 2)}
              </pre>
            </div>
            {item.result && (
              <div>
                <p className={`text-[10px] font-medium uppercase tracking-wider mb-1 ${item.result.isError ? 'text-red-400' : 'text-zinc-400'}`}>
                  Output{item.result.isError ? ' (error)' : ''}
                </p>
                <pre className={`text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-52 overflow-y-auto rounded p-2 ${item.result.isError ? 'bg-red-50 text-red-700' : 'bg-zinc-50 text-zinc-600'}`}>
                  {item.result.content || '(empty)'}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineTextItem({ item }: { item: TimelineItem & { type: 'text' } }) {
  const [expanded, setExpanded] = useState(true);
  const preview = item.content.replace(/```[a-z]*\n?/ig, '').trim().split('\n')[0]?.slice(0, 80) ?? '';

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center w-5 shrink-0">
        <div className="w-2 h-2 rounded-full bg-indigo-200 mt-2" />
        <div className="w-px flex-1 bg-zinc-100 mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <button onClick={() => setExpanded((e) => !e)} className="w-full flex items-center gap-2 py-1 text-left">
          <span className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold bg-indigo-100 text-indigo-700">Agent</span>
          <span className="text-xs text-zinc-500 truncate flex-1">{preview}{item.content.length > 80 ? '...' : ''}</span>
          <ChevronRightIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded && (
          <div className="mt-2 pl-1">
            <MarkdownWithThinking content={item.content} className="text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerTimeline({ events, status, fullHeight = false }: { events: ToolEvent[]; status: DetailStatus; fullHeight?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeline = buildTimeline(events);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || status !== 'running') return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (near) el.scrollTop = el.scrollHeight;
  }, [events.length, status]);

  if (timeline.length === 0) {
    return <div className="py-10 text-center text-xs text-zinc-300">Waiting for events...</div>;
  }

  return (
    <div ref={scrollRef} className={`overflow-y-auto pr-1 ${fullHeight ? 'h-full min-h-0' : 'max-h-[55vh]'}`}>
      {timeline.map((item, i) =>
        item.type === 'tool'
          ? <TimelineToolItem key={`t-${item.use.toolUseId ?? i}`} item={item} idx={i} />
          : <TimelineTextItem key={`x-${i}`} item={item} />
      )}
    </div>
  );
}

export function TaskDetailShared({
  workers,
  agents = ['worker'],
  status,
  detail,
  output,
  fullHeight = false,
  detailEventMode = 'all',
}: TaskDetailSharedProps) {
  const [activeTab, setActiveTab] = useState<'detail' | 'output'>('detail');
  const [activeWorker, setActiveWorker] = useState(0);

  const normalizedWorkers = workers.length > 0 ? workers : [[]];
  const hasMultiWorker = normalizedWorkers.length > 1;
  const selectedEvents = hasMultiWorker ? (normalizedWorkers[activeWorker] ?? []) : (normalizedWorkers[0] ?? []);
  const filteredDetailEvents = detailEventMode === 'tools-only'
    ? selectedEvents.filter((e) => e.type !== 'text')
    : selectedEvents;
  const detailEvents = filteredDetailEvents.length > 0 ? filteredDetailEvents : selectedEvents;
  const detailText = (detail ?? '').trim();
  const outputText = (output ?? '').trim();

  // Smart tab visibility: show both tabs only when detail and output genuinely differ.
  // - Running tasks always show both (live timeline is the execution process)
  // - Tasks with tool_use events: detail=tool execution, output=final result → different
  // - Tasks with distinct detail text (error/decision): detail text differs from output
  // - Otherwise (text-only streaming where detail ≈ output): unified view, no tabs
  const hasToolEvents = normalizedWorkers.flat().some((e) => e.type === 'tool_use');
  const hasDistinctDetail = detailText !== '' && detailText !== outputText;
  const showTabs = status === 'running' || hasToolEvents || hasDistinctDetail;

  // When tabs are hidden, show the best available content
  const effectiveTab = showTabs ? activeTab : 'unified';

  return (
    <div className={`space-y-3 ${fullHeight ? 'h-full min-h-0 flex flex-col' : ''}`}>
      {showTabs && (
        <div className="border-b border-zinc-100 flex items-center gap-1">
          <button
            onClick={() => setActiveTab('detail')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'detail'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-zinc-400 hover:text-zinc-600'
            }`}
          >
            Detail
          </button>
          <button
            onClick={() => setActiveTab('output')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'output'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-zinc-400 hover:text-zinc-600'
            }`}
          >
            Output
          </button>
        </div>
      )}

      {effectiveTab === 'detail' ? (
        <div className={`space-y-3 ${fullHeight ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
          {detailText && (
            <div className={`rounded-lg p-3 ${status === 'error' ? 'bg-red-50 text-red-700' : 'bg-zinc-50 text-zinc-700'}`}>
              <MarkdownWithThinking content={detailText} className="text-xs" />
            </div>
          )}

          {hasMultiWorker && (
            <div className="flex flex-wrap gap-1.5 pb-0.5">
              {normalizedWorkers.map((w, i) => (
                <button
                  key={i}
                  onClick={() => setActiveWorker(i)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    activeWorker === i
                      ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                      : 'bg-zinc-50 text-zinc-500 border border-zinc-100 hover:bg-zinc-100'
                  }`}
                >
                  Worker {i + 1} · {agents[i] ?? agents[0] ?? 'worker'}
                  {w.filter((e) => e.type === 'tool_use').length > 0 && (
                    <span className="ml-1 text-[10px] text-zinc-400">🔧 {w.filter((e) => e.type === 'tool_use').length}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {detailEvents.length > 0 ? (
            <WorkerTimeline events={detailEvents} status={status} fullHeight={fullHeight} />
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-xs text-zinc-400">
              No detail events captured for this task.
            </div>
          )}
        </div>
      ) : (
        <div className={`space-y-2 ${fullHeight ? 'flex-1 min-h-0' : ''}`}>
          {outputText ? (
            <div className={`text-xs whitespace-pre-wrap leading-relaxed overflow-y-auto rounded-lg p-3 ${
              fullHeight ? 'h-full min-h-0' : 'max-h-[55vh]'
            } ${
              status === 'error' ? 'bg-red-50 text-red-700' : 'bg-zinc-50'
            }`}>
              {status === 'error'
                ? <pre className="font-mono whitespace-pre-wrap">{outputText}</pre>
                : <MarkdownWithThinking content={outputText} />}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-xs text-zinc-400">
              No output yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
