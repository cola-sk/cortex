import type { Agent } from '../types';

interface Props {
  agent: Agent;
  onEdit: (agent: Agent) => void;
  onDelete: (id: string) => void;
}

const PROVIDER_META = {
  claude: { label: 'Claude', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'openai-compat': { label: 'OpenAI Compat', color: 'bg-blue-50 text-blue-700 border-blue-200' },
} as const;

function maskKey(key?: string): string {
  if (!key) return '—';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 6) + '••••••••' + key.slice(-4);
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function AgentCard({ agent, onEdit, onDelete }: Props) {
  const meta = PROVIDER_META[agent.provider.type];
  const model =
    agent.provider.type === 'claude'
      ? (agent.provider.model ?? 'default')
      : agent.provider.model;

  const baseURL =
    agent.provider.type === 'claude'
      ? agent.provider.baseURL
      : agent.provider.baseURL;

  const apiKey =
    agent.provider.type === 'claude'
      ? agent.provider.apiKey
      : agent.provider.apiKey;

  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm transition-all duration-150">
      {/* Card header */}
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <h3 className="font-mono-custom text-sm font-semibold text-zinc-800 truncate">{agent.id}</h3>
          {agent.description && (
            <p className="mt-0.5 text-xs text-zinc-400 truncate">{agent.description}</p>
          )}
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${meta.color}`}
        >
          {meta.label}
        </span>
      </div>

      {/* Model info */}
      <div className="px-4 space-y-2">
        <InfoRow label="Model" value={model} mono />
        {baseURL && <InfoRow label="Base URL" value={truncate(baseURL, 36)} mono />}
        <InfoRow label="API Key" value={maskKey(apiKey)} mono />
      </div>

      {/* System prompt preview */}
      <div className="mx-4 mt-3 rounded-lg bg-zinc-50 border border-zinc-100 px-3 py-2">
        <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">
          {agent.system}
        </p>
      </div>

      {/* Actions */}
      <div className="mt-auto flex items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
        <button
          onClick={() => onEdit(agent)}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(agent.id)}
          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-500 hover:border-red-400 hover:text-red-600 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-zinc-400 shrink-0">{label}</span>
      <span
        className={`text-xs text-zinc-600 truncate text-right ${mono ? 'font-mono-custom' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
