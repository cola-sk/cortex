import { useState, useEffect } from 'react';
import { api, type DetectedTool } from '../api';
import type { Agent } from '../types';

interface Props {
  agents: Agent[];
  onImported: () => void;
}

const TOOL_ICONS: Record<string, string> = {
  'claude-code': '◆',
  codex: '○',
  antigravity: '✦',
  hermes: '⌘',
};

export function ImportPanel({ agents, onImported }: Props) {
  const [tools, setTools] = useState<DetectedTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { text: string; ok: boolean }>>({});

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  useEffect(() => {
    api.getImporters().then(setTools).finally(() => setLoading(false));
  }, []);

  const handleImport = async (tool: DetectedTool) => {
    setImporting(tool.id);
    try {
      await api.importTool(tool.id);
      setMessages((m) => ({ ...m, [tool.id]: { text: '已导入', ok: true } }));
      onImported();
    } catch (e) {
      setMessages((m) => ({ ...m, [tool.id]: { text: (e as Error).message, ok: false } }));
    } finally {
      setImporting(null);
    }
  };

  // Re-import: delete existing non-CLI agent, then import as CLI
  const handleReimport = async (tool: DetectedTool) => {
    setImporting(tool.id);
    try {
      await api.deleteAgent(tool.id);
      await api.importTool(tool.id);
      setMessages((m) => ({ ...m, [tool.id]: { text: '已更新为 CLI', ok: true } }));
      onImported();
    } catch (e) {
      setMessages((m) => ({ ...m, [tool.id]: { text: (e as Error).message, ok: false } }));
    } finally {
      setImporting(null);
    }
  };

  if (loading) return null;

  // Show tools that are:
  // - detected AND not yet imported (→ Import button)
  // - detected AND imported but NOT as CLI (→ Update to CLI button)
  // Skip tools already imported as CLI (fully done)
  const visibleTools = tools.filter((t) => {
    if (!t.detected || !t.provider) return false;
    const existing = agentMap.get(t.id);
    if (!existing) return true; // not imported yet
    return existing.provider?.type !== 'cli'; // imported but not CLI
  });

  if (visibleTools.length === 0) return null;

  const needsUpdate = (toolId: string) => agentMap.has(toolId);

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5">
        <span className="text-xs font-medium text-zinc-500">检测到本地 CLI 工具</span>
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
          {visibleTools.length} 个
        </span>
      </div>
      <div className="divide-y divide-zinc-100">
        {visibleTools.map((tool) => {
          const icon = TOOL_ICONS[tool.id] ?? '●';
          const msg = messages[tool.id];
          const isImporting = importing === tool.id;
          const shouldUpdate = needsUpdate(tool.id);

          return (
            <div key={tool.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="text-sm text-zinc-400">{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-700">{tool.name}</span>
                  {shouldUpdate && (
                    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                      已导入（非 CLI）
                    </span>
                  )}
                </div>
                {tool.note && (
                  <span className="font-mono text-[11px] text-zinc-400">{tool.note}</span>
                )}
              </div>
              <div className="shrink-0">
                {msg?.text ? (
                  <span className={`text-[11px] font-medium ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                    {msg.ok ? '✓ ' : '✗ '}{msg.text}
                  </span>
                ) : shouldUpdate ? (
                  <button
                    onClick={() => handleReimport(tool)}
                    disabled={isImporting}
                    className="rounded border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50"
                  >
                    {isImporting ? '更新中…' : '切换为 CLI'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleImport(tool)}
                    disabled={isImporting}
                    className="rounded border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors disabled:opacity-50"
                  >
                    {isImporting ? '导入中…' : '导入'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

