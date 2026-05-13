import type { Agent, AgentRole } from '../types';

interface Props {
  agent: Agent;
  imported?: boolean;
  onEdit: (agent: Agent) => void;
  onDelete: (id: string) => void;
}

const ROLE_META: Record<AgentRole, { label: string; color: string }> = {
  orchestrator: { label: 'Orchestrator', color: 'bg-indigo-50 text-indigo-600 border-indigo-200' },
  worker:       { label: 'Worker',       color: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  reviewer:     { label: 'Reviewer',     color: 'bg-orange-50 text-orange-600 border-orange-200' },
  decider:      { label: 'Decider',      color: 'bg-purple-50 text-purple-600 border-purple-200' },
};

export function AgentCard({ agent, imported, onEdit, onDelete }: Props) {
  const roleMeta = agent.role ? ROLE_META[agent.role] : null;
  const isCli = agent.provider.type === 'cli';
  const model = isCli
    ? agent.provider.command
    : agent.provider.type === 'claude'
      ? (agent.provider.model ?? 'default')
      : agent.provider.model;

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 hover:border-zinc-300 hover:bg-zinc-50 transition-all duration-100">
      {/* ID + description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium text-zinc-800">{agent.id}</span>
          {roleMeta && (
            <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${roleMeta.color}`}>
              {roleMeta.label}
            </span>
          )}
          {imported && (
            <span className="inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
              已导入
            </span>
          )}
          {isCli && (
            <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              CLI
            </span>
          )}
        </div>
        {agent.description && (
          <p className="mt-0.5 text-xs text-zinc-400 truncate">{agent.description}</p>
        )}
      </div>

      {/* Model pill */}
      <span className="hidden sm:block font-mono text-[11px] text-zinc-400 bg-zinc-100 rounded px-2 py-0.5 shrink-0 max-w-[180px] truncate">
        {model}
      </span>

      {/* Actions — visible on hover */}
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onEdit(agent)}
          className="rounded px-2.5 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 transition-colors"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(agent.id)}
          className="rounded px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

