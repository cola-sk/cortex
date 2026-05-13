import { useState, useEffect } from 'react';
import { api, type DetectedTool } from '../api';

interface Props {
  onImported: () => void;
}

const TOOL_ICONS: Record<string, string> = {
  'claude-code': '◆',
  codex: '○',
  gemini: '✦',
  hermes: '⌘',
};

const TOOL_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  'claude-code': {
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    text: 'text-orange-700',
    badge: 'bg-orange-100 text-orange-600 border-orange-200',
  },
  codex: {
    bg: 'bg-green-50',
    border: 'border-green-200',
    text: 'text-green-700',
    badge: 'bg-green-100 text-green-600 border-green-200',
  },
  gemini: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    text: 'text-blue-700',
    badge: 'bg-blue-100 text-blue-600 border-blue-200',
  },
  hermes: {
    bg: 'bg-purple-50',
    border: 'border-purple-200',
    text: 'text-purple-700',
    badge: 'bg-purple-100 text-purple-600 border-purple-200',
  },
};

const DEFAULT_COLOR = {
  bg: 'bg-zinc-50',
  border: 'border-zinc-200',
  text: 'text-zinc-700',
  badge: 'bg-zinc-100 text-zinc-600 border-zinc-200',
};

export function ImportPanel({ onImported }: Props) {
  const [tools, setTools] = useState<DetectedTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { text: string; ok: boolean }>>({});

  useEffect(() => {
    api
      .getImporters()
      .then(setTools)
      .finally(() => setLoading(false));
  }, []);

  const handleImport = async (tool: DetectedTool) => {
    setImporting(tool.id);
    setMessages((m) => ({ ...m, [tool.id]: { text: '', ok: true } }));
    try {
      await api.importTool(tool.id);
      setMessages((m) => ({ ...m, [tool.id]: { text: 'Imported!', ok: true } }));
      onImported();
    } catch (e) {
      setMessages((m) => ({
        ...m,
        [tool.id]: { text: (e as Error).message, ok: false },
      }));
    } finally {
      setImporting(null);
    }
  };

  if (loading) return null;

  const detected = tools.filter((t) => t.detected);
  if (detected.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-500">Detected local tools</span>
        <div className="h-px flex-1 bg-zinc-200" />
        <span className="text-xs text-zinc-400">{detected.length} found</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tools.map((tool) => {
          const color = TOOL_COLORS[tool.id] ?? DEFAULT_COLOR;
          const icon = TOOL_ICONS[tool.id] ?? '●';
          const msg = messages[tool.id];
          const isImporting = importing === tool.id;

          return (
            <div
              key={tool.id}
              className={`relative flex flex-col rounded-xl border p-4 transition-opacity ${
                tool.detected ? `${color.bg} ${color.border}` : 'bg-zinc-50 border-zinc-200 opacity-40'
              }`}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className={`text-base font-bold ${tool.detected ? color.text : 'text-zinc-400'}`}>
                    {icon}
                  </span>
                  <span className={`text-xs font-semibold ${tool.detected ? color.text : 'text-zinc-400'}`}>
                    {tool.name}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                    tool.detected
                      ? color.badge
                      : 'bg-zinc-100 text-zinc-400 border-zinc-200'
                  }`}
                >
                  {tool.detected ? 'Found' : 'Not found'}
                </span>
              </div>

              {/* Model */}
              {tool.model && (
                <p className="font-mono-custom text-[11px] text-zinc-500 mb-1 truncate">{tool.model}</p>
              )}

              {/* Note */}
              {tool.note && (
                <p className="text-[11px] text-zinc-400 mb-3 leading-snug">{tool.note}</p>
              )}

              {/* Action */}
              {tool.detected && tool.provider && (
                <div className="mt-auto pt-2">
                  {msg?.text ? (
                    <p className={`text-[11px] font-medium ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                      {msg.ok ? '✓ ' : '✗ '}{msg.text}
                    </p>
                  ) : (
                    <button
                      onClick={() => handleImport(tool)}
                      disabled={isImporting}
                      className={`w-full rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${color.border} ${color.text} hover:opacity-80 bg-white`}
                    >
                      {isImporting ? 'Importing…' : 'Import as Agent'}
                    </button>
                  )}
                </div>
              )}

              {tool.detected && !tool.provider && (
                <p className="mt-auto pt-2 text-[11px] text-zinc-400">Cannot extract provider config</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
