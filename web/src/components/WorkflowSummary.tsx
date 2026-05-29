import type { ReactNode } from 'react';

export interface WorkflowSummaryNode {
  id: string;
  name: string;
  agents: string[];
  dependsOn?: string[];
}

interface WorkflowSummaryProps {
  nodes: WorkflowSummaryNode[];
  currentTaskId?: string;
  title?: string;
  emptyText?: string;
  resolveAgentLabel?: (agentId: string) => string;
  className?: string;
}

function defaultResolveAgentLabel(agentId: string): string {
  return agentId;
}

function formatAgentList(
  agents: string[],
  resolveAgentLabel: (agentId: string) => string,
): string {
  if (agents.length === 0) return '未配置';
  return agents.map(resolveAgentLabel).join(' / ');
}

function DepBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
      {children}
    </span>
  );
}

export function WorkflowSummary({
  nodes,
  currentTaskId,
  title = '工作流简介',
  emptyText = '当前任务没有可展示的工作流信息。',
  resolveAgentLabel = defaultResolveAgentLabel,
  className,
}: WorkflowSummaryProps) {
  if (nodes.length === 0) {
    return (
      <div className={`rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 ${className ?? ''}`}>
        {emptyText}
      </div>
    );
  }

  const nodeNameMap = new Map(nodes.map((node) => [node.id, node.name || node.id]));

  return (
    <div className={`rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 ${className ?? ''}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs text-indigo-500">🧭</span>
        <span className="text-xs font-semibold text-indigo-800">{title}</span>
        <span className="ml-auto text-[10px] text-indigo-500">{nodes.length} 节点</span>
      </div>

      <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
        {nodes.map((node, index) => {
          const isCurrent = node.id === currentTaskId;
          const deps = (node.dependsOn ?? []).map((depId) => nodeNameMap.get(depId) ?? depId);

          return (
            <div
              key={node.id}
              className={`rounded-md border px-2.5 py-2 text-xs ${
                isCurrent
                  ? 'border-indigo-300 bg-white shadow-sm'
                  : 'border-indigo-100/70 bg-white/80'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  isCurrent ? 'bg-indigo-100 text-indigo-700' : 'bg-zinc-100 text-zinc-600'
                }`}>
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-semibold text-zinc-800">{node.name || node.id}</span>
                    <span className="truncate text-[10px] text-zinc-400">({node.id})</span>
                    {isCurrent && (
                      <span className="ml-auto rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    Agent: {formatAgentList(node.agents, resolveAgentLabel)}
                  </div>
                  {deps.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-zinc-500">前置:</span>
                      {deps.map((dep) => (
                        <DepBadge key={`${node.id}-${dep}`}>{dep}</DepBadge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
