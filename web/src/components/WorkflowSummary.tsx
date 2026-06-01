import { useState, useRef, type ReactNode } from 'react';
import type { Agent, Provider } from '../types';

export interface WorkflowSummaryNode {
  id: string;
  name: string;
  agents: string[];
  dependsOn?: string[];
}

interface WorkflowSummaryProps {
  nodes: WorkflowSummaryNode[];
  agents?: Agent[];
  currentTaskId?: string;
  title?: string;
  emptyText?: string;
  resolveAgentLabel?: (agentId: string) => string;
  className?: string;
}

function defaultResolveAgentLabel(agentId: string): string {
  return agentId;
}

function parseAgentText(agentText: string) {
  // If it's a nested via string: "my-agent (via parent-agent (💬 claude api: model-name))"
  const viaMatch = agentText.match(/^(.*?)\s*\(via\s+(.*)\)$/);
  let name = agentText;
  let baseAgentName: string | undefined;
  let providerType: string | undefined;
  let model: string | undefined;
  let innerText = agentText;

  if (viaMatch) {
    name = viaMatch[1].trim();
    baseAgentName = viaMatch[2].trim();
    innerText = viaMatch[2]; // Use the inner part for extracting model details
  }

  const regex = /(.*?)\s*\((💬|💻)\s*(.*?)\s*:\s*([^)]+)\)$/;
  const match = innerText.match(regex);
  if (match) {
    if (viaMatch) {
      // In via cases, baseAgentName is the inner agent name
      baseAgentName = match[1].trim();
    } else {
      name = match[1].trim();
    }
    providerType = match[3].trim();
    model = match[4].trim();
  }

  return {
    name,
    baseAgentName,
    providerType,
    model,
  };
}

function getAgentAndModelDetails(agentId: string, agents?: Agent[]) {
  if (!agents) return { name: agentId, model: undefined, providerType: undefined, baseAgentName: undefined };
  
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return { name: agentId, model: undefined, providerType: undefined, baseAgentName: undefined };
  
  const resolveProvider = (a: Agent): { provider: Provider | undefined; baseAgentName?: string } => {
    if (a.provider) return { provider: a.provider };
    if (a.baseAgent) {
      const base = agents.find((ba) => ba.id === a.baseAgent);
      if (base) {
        const res = resolveProvider(base);
        return { provider: res.provider, baseAgentName: base.name || base.id };
      }
    }
    return { provider: undefined };
  };

  const { provider, baseAgentName } = resolveProvider(agent);
  
  let model: string | undefined;
  let providerType: string | undefined;
  
  if (provider) {
    if (provider.type === 'cli') {
      providerType = 'CLI';
      model = provider.command;
    } else if (provider.type === 'claude') {
      providerType = 'Claude API';
      model = provider.model || 'default';
    } else if (provider.type === 'openai-compat') {
      providerType = 'OpenAI API';
      model = provider.model;
    }
  }

  return {
    name: agent.name || agent.id,
    model,
    providerType,
    baseAgentName,
  };
}

interface HoveredNodeState {
  node: WorkflowSummaryNode;
  rect: DOMRect;
  index: number;
  nodeCenter: number;
}

export function WorkflowSummary({
  nodes,
  agents,
  currentTaskId,
  title = '工作流简介',
  emptyText = '当前任务没有可展示的工作流信息。',
  resolveAgentLabel = defaultResolveAgentLabel,
  className,
}: WorkflowSummaryProps) {
  const [hoveredNode, setHoveredNode] = useState<HoveredNodeState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (nodes.length === 0) {
    return (
      <div className={`rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 ${className ?? ''}`}>
        {emptyText}
      </div>
    );
  }

  const nodeNameMap = new Map(nodes.map((node) => [node.id, node.name || node.id]));

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, node: WorkflowSummaryNode, index: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (containerRect) {
      const nodeCenter = rect.left - containerRect.left + rect.width / 2;
      setHoveredNode({
        node,
        rect,
        index,
        nodeCenter,
      });
    }
  };

  const handleMouseLeave = () => {
    setHoveredNode(null);
  };

  // Calculate rendering metrics for the tooltip
  let tooltipLeft = 0;
  let arrowLeft = 0;
  let agentsData: Array<{ name: string; model?: string; providerType?: string }> = [];
  let deps: string[] = [];
  let isCurrent = false;

  if (hoveredNode) {
    const { node, index, nodeCenter } = hoveredNode;
    isCurrent = node.id === currentTaskId;
    deps = (node.dependsOn ?? []).map((depId) => nodeNameMap.get(depId) ?? depId);

    // Parse agent and model data
    agentsData = node.agents.length > 0 ? node.agents.map((agentId) => {
      const details = getAgentAndModelDetails(agentId, agents);
      
      // Use friendly base agent name if available, otherwise raw model
      let finalModel = details.baseAgentName || details.model;

      if (details.model || details.providerType) {
        return {
          name: details.name,
          model: finalModel,
          providerType: details.providerType,
        };
      }
      
      const label = resolveAgentLabel(agentId);
      const parsed = parseAgentText(label);
      let parsedFinalModel = parsed.baseAgentName || parsed.model;

      return {
        name: parsed.name,
        model: parsedFinalModel,
        providerType: parsed.providerType ? 
          (parsed.providerType.includes('claude') ? 'Claude API' : parsed.providerType.includes('openai') ? 'OpenAI API' : 'CLI') 
          : undefined,
      };
    }) : [{
      name: '未配置智能体',
      model: undefined,
      providerType: undefined,
    }];

    // Bounds constraint for the tooltip (w-80 is 320px)
    const tooltipWidth = 320;
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    
    tooltipLeft = nodeCenter;
    if (containerWidth > tooltipWidth) {
      tooltipLeft = Math.max(tooltipWidth / 2 + 8, Math.min(containerWidth - tooltipWidth / 2 - 8, tooltipLeft));
    }
    
    // Position the arrow relative to the tooltip box
    arrowLeft = Math.max(16, Math.min(296, nodeCenter - tooltipLeft + 160));
  }

  return (
    <div 
      ref={containerRef}
      className={`relative rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap no-scrollbar">
        <div className="flex items-center gap-1.5 shrink-0 pr-3 border-r border-indigo-200/80">
          <span className="text-[13px] text-indigo-500">🧭</span>
          <span className="text-xs font-semibold text-indigo-800">{title}</span>
        </div>
        
        <div className="flex items-center gap-1.5 shrink-0 pl-1">
          {nodes.map((node, index) => {
            const isNodeCurrent = node.id === currentTaskId;
            
            // Resolve model display for the first agent to show directly on the node
            const firstAgentId = node.agents[0];
            const agentDetails = firstAgentId ? getAgentAndModelDetails(firstAgentId, agents) : null;
            let modelDisplay = agentDetails ? (agentDetails.baseAgentName || agentDetails.model) : undefined;

            if (!modelDisplay && firstAgentId) {
              const label = resolveAgentLabel(firstAgentId);
              const parsed = parseAgentText(label);
              modelDisplay = parsed.baseAgentName || parsed.model;
            }
            
            return (
              <div key={node.id} className="flex items-center gap-1.5 shrink-0">
                {index > 0 && <span className="text-indigo-300/80 text-[10px] font-bold">→</span>}
                <div
                  onMouseEnter={(e) => handleMouseEnter(e, node, index)}
                  onMouseLeave={handleMouseLeave}
                  className={`flex items-center gap-2 rounded-full pl-1 pr-2.5 py-1 text-[11px] border cursor-pointer select-none transition-all duration-700 ${
                    isNodeCurrent
                      ? 'border-indigo-400 bg-indigo-500 text-white font-medium shadow-sm ring-2 ring-indigo-500/20'
                      : 'border-indigo-200/80 bg-white/90 text-zinc-600 hover:bg-white hover:border-indigo-400 hover:shadow-sm'
                  }`}
                >
                  <span className={`flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-semibold shrink-0 ${
                    isNodeCurrent ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-500'
                  }`}>
                    {index + 1}
                  </span>
                  <span className="font-medium">{node.name || node.id}</span>
                  {modelDisplay && (
                    <span className={`text-[9px] font-mono font-semibold rounded px-1.5 py-0.25 shrink-0 transition-all ${
                      isNodeCurrent 
                        ? 'bg-white/20 text-white border border-white/10' 
                        : 'bg-zinc-100 text-zinc-400 border border-zinc-200/40'
                    }`}>
                      {modelDisplay}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Elegant light-theme custom tooltip rendered inside the non-overflow relative container */}
      {hoveredNode && (
        <div
          className="absolute z-50 pointer-events-none rounded-xl border border-zinc-200 bg-white shadow-xl p-4 text-xs text-zinc-600 w-80 flex flex-col gap-3 transition-all duration-100 ease-out animate-in fade-in-0 zoom-in-95"
          style={{
            top: 'calc(100% + 10px)',
            left: tooltipLeft,
            transform: 'translateX(-50%)',
          }}
        >
          {/* Arrow */}
          <div 
            className="absolute top-[-5.5px] w-2.5 h-2.5 bg-white border-t border-l border-zinc-200 rotate-45"
            style={{ left: arrowLeft, transform: 'translateX(-50%) rotate(45deg)' }}
          />

          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-zinc-100 pb-2.5">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded uppercase tracking-wider">
                  Step {hoveredNode.index + 1}
                </span>
                {isCurrent && (
                  <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded uppercase tracking-wider animate-pulse">
                    Current Task
                  </span>
                )}
              </div>
              <span className="font-semibold text-zinc-800 text-[13px] mt-0.5 break-words">
                {hoveredNode.node.name || hoveredNode.node.id}
              </span>
            </div>
            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-50 border border-zinc-150 px-1.5 py-0.5 rounded shrink-0">
              {hoveredNode.node.id}
            </span>
          </div>

          {/* Agents Info */}
          <div className="flex flex-col gap-2.5">
            {agentsData.map((agent, i) => (
              <div key={i} className="bg-zinc-50/60 rounded-lg p-2.5 border border-zinc-150 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">
                    执行智能体 (Agent)
                  </span>
                  {agent.providerType && (
                    <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 bg-zinc-100 text-zinc-500 rounded border border-zinc-200/50">
                      {agent.providerType}
                    </span>
                  )}
                </div>
                
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-indigo-700 font-semibold">{agent.name}</span>
                </div>

                {agent.model && (
                  <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2">
                    <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">
                      运行模型 (Model)
                    </span>
                    <div className="flex items-center gap-1.5 bg-zinc-50 rounded px-2 py-1">
                      <span className="text-[10px]">🤖</span>
                      <span className="font-mono text-[10.5px] text-emerald-700 break-all select-all font-semibold">
                        {agent.model}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Dependencies */}
          {deps.length > 0 && (
            <div className="border-t border-zinc-100 pt-2.5 flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">
                前置依赖任务 (Depends On)
              </span>
              <div className="flex flex-wrap gap-1">
                {deps.map((depName) => (
                  <span key={depName} className="text-[9.5px] font-medium px-2 py-0.5 bg-zinc-50 border border-zinc-150 text-zinc-500 rounded">
                    {depName}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
