import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import type { ToolEvent } from '../types';

export type DetailStatus = 'running' | 'done' | 'error' | 'decision' | 'interrupted';

type ContentSection = { kind: 'markdown' | 'thinking'; content: string };
type TextBlockKind = 'diff' | 'text';
type TextBlock = { kind: TextBlockKind; content: string };
type TextEventKind = 'agent' | 'exec' | 'command_result' | 'patch' | 'diff' | 'runtime';

type TimelineItem =
  | { type: 'tool'; use: ToolEvent; result?: ToolEvent; index: number }
  | { type: 'text'; content: string; index: number };

const AUTO_SCROLL_BOTTOM_GAP = 24;

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

function prepareDisplayContent(input: string): string {
  const normalized = normalizeMixedContent(input);
  if (/<(thinking|think)>/i.test(normalized)) return normalized;

  const trimmed = normalized.trim();
  // High performance: only try JSON parsing if the content is small and looks like JSON.
  if (trimmed.length < 50000 && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
      }
    } catch {
      // ignore
    }
  }

  return normalized;
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
  const proseClass = `prose prose-sm max-w-none text-zinc-800 leading-relaxed font-sans
      prose-headings:text-zinc-900 prose-headings:font-semibold prose-headings:tracking-tight
      prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
      prose-code:bg-zinc-100 prose-code:text-zinc-850 prose-code:rounded prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[11.5px] prose-code:font-mono-custom prose-code:border prose-code:border-zinc-200/60
      prose-pre:bg-[#282c34] prose-pre:text-zinc-100 prose-pre:rounded-lg prose-pre:text-[12.5px] prose-pre:overflow-x-auto prose-pre:!p-4 prose-pre:!my-3 prose-pre:!mx-0 prose-pre:shadow-md prose-pre:border prose-pre:border-zinc-800/80 prose-pre:font-mono-custom
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

function getTextEventMeta(content: string): {
  kind: TextEventKind;
  label: string;
  badgeClass: string;
  preview: string;
  secondary: string;
} {
  const normalized = normalizeMixedContent(content).trim();
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const second = lines[1] ?? '';
  const fallbackPreview = first.slice(0, 120);
  const fallbackSecondary = second.slice(0, 140);

  if (/^exec$/i.test(first) || /^exec\b/i.test(first)) {
    return {
      kind: 'exec',
      label: 'Exec',
      badgeClass: 'bg-blue-100 text-blue-700',
      preview: (second || fallbackPreview || 'exec').slice(0, 120),
      secondary: lines.slice(2).join(' ').slice(0, 140),
    };
  }

  if (/^(succeeded|failed) in\s/i.test(first)) {
    return {
      kind: 'command_result',
      label: 'Result',
      badgeClass: 'bg-emerald-100 text-emerald-700',
      preview: first.slice(0, 120),
      secondary: fallbackSecondary,
    };
  }

  if (/^apply patch$/i.test(first) || /^patch:/i.test(first)) {
    return {
      kind: 'patch',
      label: 'Patch',
      badgeClass: 'bg-amber-100 text-amber-700',
      preview: first.slice(0, 120),
      secondary: fallbackSecondary,
    };
  }

  if (/^diff --git\s/.test(first)) {
    return {
      kind: 'diff',
      label: 'Diff',
      badgeClass: 'bg-zinc-800 text-white',
      preview: first.slice(0, 120),
      secondary: fallbackSecondary,
    };
  }

  if (/^Reading additional input from stdin/i.test(first) || /^OpenAI Codex v/i.test(first)) {
    return {
      kind: 'runtime',
      label: 'Runtime',
      badgeClass: 'bg-zinc-100 text-zinc-600',
      preview: first.slice(0, 120),
      secondary: fallbackSecondary,
    };
  }

  return {
    kind: 'agent',
    label: 'Agent',
    badgeClass: 'bg-indigo-100 text-indigo-700',
    preview: fallbackPreview,
    secondary: fallbackSecondary,
  };
}

function isDiffHeaderLine(line: string): boolean {
  return (
    /^diff --git\s/.test(line) ||
    /^index\s+[0-9a-f]{7,}\.\.[0-9a-f]{7,}(?:\s+\d+)?$/i.test(line) ||
    /^@@\s/.test(line) ||
    /^---\s(?:a\/|b\/|\/dev\/null|\S)/.test(line) ||
    /^\+\+\+\s(?:a\/|b\/|\/dev\/null|\S)/.test(line) ||
    /^Binary files .+ differ$/.test(line)
  );
}

function isDiffPayloadLine(line: string): boolean {
  return (
    /^[ +-]/.test(line) ||
    /^\\ No newline at end of file$/.test(line)
  );
}

function splitTextBlocks(content: string): TextBlock[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const blocks: Array<{ kind: TextBlockKind; lines: string[] }> = [];
  let inDiffBlock = false;
  let hasStrongDiffMarker = false;

  const pushLine = (kind: TextBlockKind, line: string) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      last.lines.push(line);
      return;
    }
    blocks.push({ kind, lines: [line] });
  };

  for (const line of lines) {
    const strongDiffLine = isDiffHeaderLine(line);
    if (strongDiffLine) {
      inDiffBlock = true;
      hasStrongDiffMarker = true;
      pushLine('diff', line);
      continue;
    }

    if (inDiffBlock) {
      if (isDiffPayloadLine(line) || !line.trim()) {
        pushLine('diff', line);
        continue;
      }
      inDiffBlock = false;
    }

    pushLine('text', line);
  }

  if (!hasStrongDiffMarker) {
    return [{ kind: 'text', content }];
  }

  return blocks
    .map((block) => ({
      kind: block.kind,
      content: block.lines.join('\n').replace(/^\n+|\n+$/g, ''),
    }))
    .filter((block) => block.content.trim());
}

function looksLikeDiffContent(content: string): boolean {
  return splitTextBlocks(content).some((block) => block.kind === 'diff');
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
  const [expanded, setExpanded] = useState(false);
  const normalized = normalizeMixedContent(item.content).trim();
  const blocks = splitTextBlocks(normalized);
  const lines = normalized.split('\n').filter(Boolean);
  const textMeta = getTextEventMeta(normalized);
  const preview = textMeta.preview.slice(0, 92);
  const secondary = textMeta.secondary.slice(0, 110);
  const lineCount = lines.length;
  const charCount = normalized.length;
  const hasDiffBlocks = blocks.some((block) => block.kind === 'diff');
  const hasTextBlocks = blocks.some((block) => block.kind === 'text');
  const outputTypeLabel = hasDiffBlocks
    ? (hasTextBlocks ? 'Mixed Output' : 'Code Diff')
    : 'Agent Log';

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center w-5 shrink-0">
        <div className="w-2 h-2 rounded-full bg-indigo-200 mt-2" />
        <div className="w-px flex-1 bg-zinc-100 mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <button onClick={() => setExpanded((e) => !e)} className="w-full flex items-center gap-2 py-1 text-left">
          <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ${textMeta.badgeClass}`}>{textMeta.label}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-xs text-zinc-600 truncate">{preview}{item.content.length > 80 ? '...' : ''}</span>
            {secondary && <span className="block text-[10px] text-zinc-400 truncate">{secondary}</span>}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-300">{lineCount}L · {charCount}C</span>
          <ChevronRightIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded && (
          <div className="mt-2">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/80 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-zinc-200 bg-white/80 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                  {outputTypeLabel}
                </span>
                <span className="text-[10px] text-zinc-400">{lineCount} lines</span>
              </div>
              {hasDiffBlocks && !hasTextBlocks ? (
                <div className="px-2 py-2 max-h-[70vh] overflow-auto bg-zinc-950">
                  <MarkdownWithThinking content={`\`\`\`diff\n${normalized}\n\`\`\``} className="text-xs" />
                </div>
              ) : hasDiffBlocks ? (
                <div className="px-2 py-2 max-h-[70vh] overflow-auto space-y-2 bg-zinc-50">
                  {blocks.map((block, index) => (
                    <div key={`${block.kind}-${index}`} className="rounded-md border border-zinc-200 bg-white overflow-hidden">
                      <div className="px-2 py-1 border-b border-zinc-100 bg-zinc-50/70 text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                        {block.kind === 'diff' ? 'Code Diff' : 'Text'}
                      </div>
                      {block.kind === 'diff' ? (
                        <div className="px-2 py-2 bg-zinc-950 overflow-auto">
                          <MarkdownWithThinking content={`\`\`\`diff\n${block.content}\n\`\`\``} className="text-xs" />
                        </div>
                      ) : (
                        <pre className="px-3 py-2 text-[12px] leading-5 text-zinc-700 whitespace-pre-wrap break-words font-mono overflow-auto">
                          {block.content}
                        </pre>
                      )}
                    </div>
                  ))}
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

function isNearBottom(el: HTMLDivElement, gap = AUTO_SCROLL_BOTTOM_GAP): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= gap;
}

function WorkerTimeline({ events, status, fullHeight = false }: { events: ToolEvent[]; status: DetailStatus; fullHeight?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScrollRef = useRef(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const timeline = buildTimeline(events);

  const handleTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || isProgrammaticScrollRef.current) return;
    if (isNearBottom(el)) {
      setAutoFollow((prev) => (prev ? prev : true));
      return;
    }
    if (status === 'running') {
      setAutoFollow((prev) => (prev ? false : prev));
    }
  };

  useEffect(() => {
    if (status === 'running') setAutoFollow(true);
  }, [status]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || status !== 'running' || !autoFollow) return;
    isProgrammaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });
  }, [autoFollow, events.length, status]);

  if (timeline.length === 0) {
    return <div className="py-10 text-center text-xs text-zinc-300">Waiting for events...</div>;
  }

  return (
    <div ref={scrollRef} onScroll={handleTimelineScroll} className={`overflow-y-auto pr-1 ${fullHeight ? 'h-full min-h-0' : 'max-h-[55vh]'}`}>
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
        <div className="flex flex-col border border-zinc-200/70 rounded-xl overflow-hidden bg-white shadow-sm">
          {/* Output Document Header */}
          <div className="bg-zinc-50 border-b border-zinc-150 px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 flex items-center gap-1.5 select-none">
              📄 Output Document
            </span>
            <span className="text-[10px] text-zinc-400 font-mono">
              {workerOutput.length} characters
            </span>
          </div>
          
          {/* Output Document View */}
          <div className={`overflow-y-auto px-5 py-4 sm:px-6 sm:py-5 leading-relaxed bg-zinc-50/20 ${
              fullHeight && !timelineOpen ? 'flex-1 min-h-0' : 'max-h-[60vh]'
          }`}>
            <MarkdownWithThinking
              content={workerOutput}
              markdownClassName="text-xs sm:text-sm text-zinc-700 leading-relaxed max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2"
            />
          </div>
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
