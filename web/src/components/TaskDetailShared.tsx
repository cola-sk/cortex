import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ToolEvent } from '../types';

export type DetailStatus = 'running' | 'done' | 'error' | 'decision' | 'interrupted';

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
  outputs?: string[];                // per-worker outputs
  workerStatus?: ('running' | 'done' | 'error')[];
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

function guessLanguageFromCodeText(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return 'text';

  const commandLineCount = lines.filter((line) =>
    /^(?:\$|#)?\s*(npm|pnpm|yarn|bun|node|npx|git|ls|cd|cat|echo|curl|wget|python|pip|go|cargo|docker|kubectl|helm|make|cmake|uv|pytest|java|javac|mvn|gradle|apt|brew)\b/i.test(line)
  ).length;
  if (commandLineCount >= Math.max(2, Math.ceil(lines.length * 0.5))) return 'bash';

  const htmlLikeCount = lines.filter((line) => /<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(line)).length;
  if (htmlLikeCount >= Math.max(2, Math.ceil(lines.length * 0.4))) return 'html';

  const pythonLikeCount = lines.filter((line) =>
    /^def\s+\w+\(|^class\s+\w+|^from\s+\w+\s+import|^import\s+\w+|:\s*$/.test(line)
  ).length;
  if (pythonLikeCount >= Math.max(2, Math.ceil(lines.length * 0.35))) return 'python';

  const tsLikeCount = lines.filter((line) =>
    /\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(string|number|boolean|unknown|any|Record<|Array<|Promise<)/.test(line)
  ).length;
  if (tsLikeCount >= Math.max(1, Math.ceil(lines.length * 0.25))) return 'typescript';

  const jsLikeCount = lines.filter((line) =>
    /\b(const|let|var|function|class|import|export|return)\b|=>|[{};]/.test(line)
  ).length;
  if (jsLikeCount >= Math.max(2, Math.ceil(lines.length * 0.35))) return 'javascript';

  const yamlLikeCount = lines.filter((line) => /^[\w"-]+\s*:\s*.+$/.test(line) && !/[{};]/.test(line)).length;
  if (yamlLikeCount >= Math.max(2, Math.ceil(lines.length * 0.6))) return 'yaml';

  return 'text';
}

function formatCodeLikeText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.includes('```')) return null;

  const lines = trimmed.split('\n');
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length < 2) return null;

  const codeIndicatorCount = nonEmptyLines.filter((line) =>
    /[{};]/.test(line) ||
    /\b(const|let|var|function|class|import|export|return|if|else|for|while|switch|case|def|from|SELECT|INSERT|UPDATE|DELETE)\b/.test(line) ||
    /^<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(line) ||
    /^(?:\$|#)?\s*(npm|pnpm|yarn|bun|node|npx|git|ls|cd|cat|echo|curl|wget|python|pip|go|cargo|docker|kubectl|helm|make|cmake|uv|pytest|java|javac|mvn|gradle|apt|brew)\b/i.test(line)
  ).length;

  const sentenceLikeCount = nonEmptyLines.filter((line) =>
    /[.!?。！？]$/.test(line) && line.split(/\s+/).length >= 6
  ).length;

  if (codeIndicatorCount < Math.max(2, Math.ceil(nonEmptyLines.length * 0.45))) return null;
  if (sentenceLikeCount > Math.ceil(nonEmptyLines.length * 0.4)) return null;

  const lang = guessLanguageFromCodeText(trimmed);
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

function prepareDisplayContent(input: string): string {
  const normalized = normalizeMixedContent(input);
  if (/<(thinking|think)>/i.test(normalized)) return normalized;
  return formatJsonLikeText(normalized) ?? formatCodeLikeText(normalized) ?? normalized;
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

export function MarkdownWithThinking({
  content,
  className,
  markdownClassName,
}: {
  content: string;
  className?: string;
  markdownClassName?: string;
}) {
  const sections = splitThinkingSections(content);
  const proseClass = `prose prose-sm max-w-none text-zinc-800 leading-relaxed
      prose-headings:text-zinc-900 prose-headings:font-semibold prose-headings:tracking-tight
      prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5
      prose-code:bg-zinc-100 prose-code:text-zinc-800 prose-code:rounded prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[12px]
      prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-pre:rounded-md prose-pre:text-[12px] prose-pre:overflow-x-auto prose-pre:!px-1 prose-pre:!py-1 prose-pre:!my-0 prose-pre:!mx-0 prose-pre:shadow-sm
      prose-a:text-indigo-600 prose-blockquote:border-l-4 prose-blockquote:border-l-indigo-300 prose-blockquote:text-zinc-500 prose-blockquote:pl-4 prose-blockquote:italic
      prose-table:text-xs prose-th:bg-zinc-50 prose-td:py-1.5 prose-th:py-2 prose-td:px-3 prose-th:px-3`;

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {sections.map((section, idx) => {
        if (section.kind === 'thinking') {
          return (
            <details key={`think-${idx}`} className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
              <summary className="cursor-pointer select-none text-[11px] font-semibold text-amber-700">Thinking</summary>
              <div className={`mt-2 ${proseClass} prose-amber text-amber-900 ${markdownClassName ?? ''}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{section.content}</ReactMarkdown>
              </div>
            </details>
          );
        }

        return (
          <div key={`md-${idx}`} className={`${proseClass} ${markdownClassName ?? ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{section.content}</ReactMarkdown>
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

function looksLikeStandaloneTextBlock(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return /^(Reading additional input from stdin|Goal:|Human feedback|Previous revision history|Based on the above feedback|===|\[SECURITY POLICY)/i.test(trimmed);
}

function looksLikeDiffContent(content: string): boolean {
  if (!content.trim()) return false;
  return /(^diff --git\s|^index\s+[0-9a-f]+\.\.[0-9a-f]+|^@@\s|^---\s|^\+\+\+\s)/m.test(content);
}

function shouldMergeTextEvents(previous: string, incoming: string): boolean {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!prev || !next) return true;

  // Keep diff chunks contiguous so users can view the whole patch in one section.
  if (looksLikeDiffContent(previous) || looksLikeDiffContent(incoming)) {
    return previous.length + incoming.length < 120_000;
  }

  if (looksLikeStandaloneTextBlock(next)) return false;
  if (previous.length > 1800 || incoming.length > 900) return false;

  const nextStartsNewSection = /^([A-Z][\w -]{2,32}:|\[[^\]]+\]|===)/.test(next);
  if (nextStartsNewSection) return false;

  const prevEndsSentence = /[.!?;:]$/.test(prev);
  if (prevEndsSentence && next.length > 120) return false;

  return true;
}

/** Check if a text event is an internal CLI protocol message (e.g. Claude Code stream-json system/assistant/user envelopes) */
function isCliProtocolJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    // Claude Code stream-json emits { type: "system"|"assistant"|"user", ... } wrapper messages
    return typeof obj === 'object' && obj !== null && typeof obj.type === 'string';
  } catch {
    return false;
  }
}

function buildTimeline(events: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let idx = 0;
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === ev.toolUseId);
      items.push({ type: 'tool', use: ev, result, index: idx++ });
    } else if (ev.type === 'text') {
      const content = ev.content ?? '';
      // Skip internal CLI protocol JSON messages (not human-readable)
      if (isCliProtocolJson(content)) continue;
      // Skip empty/whitespace-only text
      if (!content.trim()) continue;
      const last = items[items.length - 1];
      if (last && last.type === 'text') {
        if (shouldMergeTextEvents(last.content, content)) {
          last.content = appendTextChunk(last.content, content);
        } else {
          items.push({ type: 'text', content, index: idx++ });
        }
      } else {
        items.push({ type: 'text', content, index: idx++ });
      }
    }
  }
  return items;
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

function TimelineToolItem({ item, idx }: { item: TimelineItem & { type: 'tool' }; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummaryText(item.use);
  
  const lang = getToolLanguage(item.use.name, item.use.input);
  const inputMarkdown = item.use.input 
    ? `\`\`\`json\n${JSON.stringify(item.use.input, null, 2)}\n\`\`\``
    : `\`\`\`text\n${summary}\n\`\`\n`;
  const outputMarkdown = item.result 
    ? `\`\`\`${lang}\n${item.result.content || '(empty)'}\n\`\`\``
    : '';

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
          <div className="mt-1 space-y-2.5 pl-1">
            <div>
              <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Input</p>
              <div className="rounded-xl border border-zinc-200/50 bg-zinc-950 p-1 overflow-x-auto max-h-64">
                <MarkdownWithThinking content={inputMarkdown} />
              </div>
            </div>
            {item.result && (
              <div>
                <p className={`text-[10px] font-medium uppercase tracking-wider mb-1 ${item.result.isError ? 'text-red-400' : 'text-zinc-400'}`}>
                  Output{item.result.isError ? ' (error)' : ''}
                </p>
                <div className={`rounded-xl border max-h-96 overflow-x-auto p-1 bg-zinc-950 ${
                  item.result.isError ? 'border-red-200/50 bg-red-950/20' : 'border-zinc-200/50 bg-zinc-950'
                }`}>
                  <MarkdownWithThinking content={outputMarkdown} />
                </div>
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
  const normalized = normalizeMixedContent(item.content).trim();
  const lines = normalized.split('\n').filter(Boolean);
  const preview = lines[0]?.slice(0, 92) ?? '';
  const lineCount = lines.length;
  const isDiffBlock = looksLikeDiffContent(normalized);

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
          <div className="mt-2">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/80 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-zinc-200 bg-white/80 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                  {isDiffBlock ? 'Diff Output' : 'Agent Log'}
                </span>
                <span className="text-[10px] text-zinc-400">{lineCount} lines</span>
              </div>
              {isDiffBlock ? (
                <div className="px-2 py-2 max-h-[70vh] overflow-auto bg-zinc-950">
                  <MarkdownWithThinking content={`\`\`\`diff\n${normalized}\n\`\`\``} className="text-xs" />
                </div>
              ) : (
                <pre className="px-3 py-2 text-[12px] leading-5 text-zinc-700 whitespace-pre-wrap break-words font-mono max-h-[45vh] overflow-auto">
                  {normalized}
                </pre>
              )}
            </div>
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
  outputs,
  workerStatus,
  fullHeight = false,
  detailEventMode = 'all',
}: TaskDetailSharedProps) {
  const [activeWorker, setActiveWorker] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const normalizedWorkers = workers.length > 0 ? workers.map((w) => w ?? []) : [[]];
  const hasMultiWorker = normalizedWorkers.length > 1;
  const selectedEvents = hasMultiWorker ? (normalizedWorkers[activeWorker] ?? []) : (normalizedWorkers[0] ?? []);
  const filteredDetailEvents = detailEventMode === 'tools-only'
    ? selectedEvents.filter((e) => e.type !== 'text')
    : selectedEvents;
  const detailEvents = filteredDetailEvents.length > 0 ? filteredDetailEvents : selectedEvents;
  const detailText = (detail ?? '').trim();
  const outputText = (output ?? '').trim();
  const isRunning = status === 'running';

  // Per-worker: use outputs array if available, otherwise fall back to combined output
  const perWorkerOutputs = hasMultiWorker && outputs && outputs.length > 1 ? outputs : null;
  const workerOutput = perWorkerOutputs
    ? (perWorkerOutputs[activeWorker] ?? '').trim()
    : outputText;

  // Keep timeline available even when a run produced only text events.
  const selectedToolCallCount = selectedEvents.filter((e) => e.type === 'tool_use').length;
  const workerHasEvents = selectedEvents.length > 0;

  const workerTabs = hasMultiWorker && (
    <div className="flex flex-wrap gap-1.5 pb-0.5">
      {normalizedWorkers.map((w, i) => {
        const toolCount = w.filter((e) => e.type === 'tool_use').length;
        const wStatus = workerStatus?.[i];
        const statusIcon = wStatus === 'done' ? '✓' : wStatus === 'error' ? '✗' : isRunning ? '●' : '';
        const statusColor = wStatus === 'done' ? 'text-emerald-500' : wStatus === 'error' ? 'text-red-500' : 'text-blue-400';
        return (
          <button
            key={i}
            onClick={() => setActiveWorker(i)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              activeWorker === i
                ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                : 'bg-zinc-50 text-zinc-500 border border-zinc-100 hover:bg-zinc-100'
            }`}
          >
            {statusIcon && <span className={`mr-1 ${statusColor}`}>{statusIcon}</span>}
            Worker {i + 1} · {agents[i] ?? agents[0] ?? 'worker'}
            {toolCount > 0 && (
              <span className="ml-1 text-[10px] text-zinc-400">🔧 {toolCount}</span>
            )}
          </button>
        );
      })}
    </div>
  );

  // ── Running: worker tabs + live timeline ──
  if (isRunning) {
    return (
      <div className={`space-y-3 ${fullHeight ? 'h-full min-h-0 flex flex-col' : ''}`}>
        {detailText && (
          <div className="rounded-lg p-3 bg-zinc-50 text-zinc-700">
            <MarkdownWithThinking content={detailText} className="text-xs" />
          </div>
        )}
        {workerTabs}
        {detailEvents.length > 0 ? (
          <WorkerTimeline events={detailEvents} status={status} fullHeight={fullHeight} />
        ) : (
          <div className="py-10 text-center text-xs text-zinc-300 animate-pulse">Waiting for events...</div>
        )}
      </div>
    );
  }

  // ── Done / Error / Decision ──
  // Multi-worker: worker tabs, each tab shows that worker's output + that worker's timeline
  // Single-worker: output + collapsible timeline (only if has tool events)
  return (
    <div className={`space-y-2 ${fullHeight ? 'h-full min-h-0 flex flex-col' : ''}`}>
      {/* Error banner */}
      {detailText && status === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50/70 p-4 text-red-800 shadow-sm border-l-4 border-l-red-500">
          <MarkdownWithThinking content={detailText} className="text-xs" />
        </div>
      )}

      {/* Decision banner */}
      {detailText && status === 'decision' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-amber-900 shadow-sm border-l-4 border-l-amber-500">
          <MarkdownWithThinking content={detailText} className="text-xs" />
        </div>
      )}

      {/* Interrupted banner */}
      {status === 'interrupted' && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 text-zinc-700 shadow-sm border-l-4 border-l-zinc-400">
          <p className="text-xs font-medium">任务已中断，提交评论后可继续执行。</p>
        </div>
      )}

      {/* Worker tabs for multi-worker */}
      {workerTabs}

      {workerOutput ? (
        <div className={`overflow-y-auto border border-zinc-200/80 bg-white rounded-lg p-0 leading-relaxed ${
            fullHeight && !timelineOpen ? 'flex-1 min-h-0' : 'max-h-[60vh]'
        }`}>
          <MarkdownWithThinking
            content={workerOutput}
            markdownClassName="text-[11px] leading-[1.45] px-1 py-0.5 prose-pre:text-[11px] prose-pre:!my-0 prose-pre:!mx-0 prose-pre:!px-1 prose-pre:!py-1"
          />
        </div>
      ) : (
        !detailText && (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-6 text-center text-xs text-zinc-400">
            No output.
          </div>
        )
      )}

      {/* Collapsible execution timeline — keep it for both tool and text events */}
      {workerHasEvents && (
        <div className={`${fullHeight && timelineOpen ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
          <button
            onClick={() => setTimelineOpen((o) => !o)}
            className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-600 transition-colors py-1"
          >
            <ChevronRightIcon className={`w-3 h-3 transition-transform ${timelineOpen ? 'rotate-90' : ''}`} />
            <span className="font-medium">Execution Timeline</span>
            <span className="text-[10px]">
              {selectedToolCallCount > 0
                ? `(${selectedToolCallCount} tool calls)`
                : `(${selectedEvents.length} events)`}
            </span>
          </button>
          {timelineOpen && (
            <div className={`mt-1 ${fullHeight ? 'flex-1 min-h-0' : ''}`}>
              <WorkerTimeline events={detailEvents} status={status} fullHeight={fullHeight} />
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
