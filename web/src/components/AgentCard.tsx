import type { Agent, AgentRole } from '../types';
import { useTranslation } from 'react-i18next';

interface Props {
  agent: Agent;
  modelLabel?: string;
  imported?: boolean;
  onEdit: (agent: Agent) => void;
  onDelete: (id: string) => void;
}

const ROLE_COLOR: Record<AgentRole, string> = {
  orchestrator: 'bg-indigo-50 text-indigo-600 border-indigo-200',
  worker:       'bg-emerald-50 text-emerald-600 border-emerald-200',
  reviewer:     'bg-orange-50 text-orange-600 border-orange-200',
  decider:      'bg-purple-50 text-purple-600 border-purple-200',
};

export function AgentCard({ agent, modelLabel, imported, onEdit, onDelete }: Props) {
  const { t } = useTranslation();
  const roleColor = agent.role ? ROLE_COLOR[agent.role] : null;
  const isCli = agent.provider?.type === 'cli';
  const fallbackModel = !agent.provider
    ? agent.baseAgent ?? ''
    : isCli
    ? (agent.provider as import('../types').CliProvider).command
    : agent.provider.type === 'claude'
      ? ((agent.provider as import('../types').ClaudeProvider).model ?? 'default')
      : (agent.provider as import('../types').OpenAICompatProvider).model;
  const model = modelLabel ?? fallbackModel;

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 hover:border-zinc-300 hover:bg-zinc-50 transition-all duration-100">
      {/* ID + description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium text-zinc-800">{agent.name || agent.id}</span>
          {agent.name && (
            <span className="text-xs text-zinc-400 font-mono">#{agent.id}</span>
          )}
          {agent.role && roleColor && (
            <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${roleColor}`}>
              {t(`role.${agent.role}`)}
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

