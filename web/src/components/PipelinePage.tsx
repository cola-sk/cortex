import { useState, useEffect, useRef, useCallback } from 'react';
import type { Agent, Pipeline, PipelineTask, PipelineDecision, RunEventType, ToolEvent } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { TaskDetailShared, MarkdownWithThinking } from './TaskDetailShared';

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  icon: string;
  pipeline: Omit<Pipeline, 'id'>;
}> = [
  {
    id: 'chain',
    name: 'Plan → Code → Review',
    description: 'Sequential chain with a quality gate: orchestrator plans, worker implements, reviewer checks. Decider can retry the implementation.',
    icon: '→',
    pipeline: {
      name: 'Code Pipeline',
      description: 'Sequential: plan → implement → review with quality gate',
      tasks: [
        { id: 'plan', name: 'Planning', agent: 'orchestrator', input: 'Analyse the goal and produce a detailed implementation plan.', dependsOn: [] },
        { id: 'implement', name: 'Implementation', agent: 'coder', input: 'Implement the solution according to the plan.', dependsOn: ['plan'] },
        { id: 'review', name: 'Code Review', agent: 'reviewer', input: 'Review the implementation for correctness, security, and code quality.', dependsOn: ['implement'] },
      ],
      decisions: [{ id: 'quality_gate', name: 'Quality Gate', agent: 'decider', evaluates: ['review'], maxRetries: 2 }],
    },
  },
  {
    id: 'parallel_workers',
    name: 'Parallel Workers → Synthesize',
    description: 'Multiple workers independently tackle the same problem, then a synthesizer picks the best ideas from all outputs.',
    icon: '⇶',
    pipeline: {
      name: 'Parallel Analysis',
      description: 'Multiple independent workers → synthesizer',
      tasks: [
        { id: 'parallel_think', name: 'Independent Analysis', agent: ['coder', 'coder', 'coder'], input: 'Approach this problem independently. Provide your best solution with reasoning.', dependsOn: [] },
        { id: 'synthesize', name: 'Synthesize Results', agent: 'reviewer', input: 'Review all approaches above and synthesize the best overall solution.', dependsOn: ['parallel_think'] },
      ],
      decisions: [],
    },
  },
  {
    id: 'research',
    name: 'Parallel Research → Analyse → Report',
    description: 'Multiple parallel research tracks are independently investigated, cross-analysed, then compiled into a final report.',
    icon: '⊕',
    pipeline: {
      name: 'Research Pipeline',
      description: 'Parallel research → cross analysis → final report',
      tasks: [
        { id: 'research_a', name: 'Research Track A', agent: 'coder', input: 'Research the first aspect of the topic. Be thorough.', dependsOn: [] },
        { id: 'research_b', name: 'Research Track B', agent: 'coder', input: 'Research the second aspect of the topic. Be thorough.', dependsOn: [] },
        { id: 'analyze', name: 'Cross Analysis', agent: 'reviewer', input: 'Compare and analyse the findings from both research tracks.', dependsOn: ['research_a', 'research_b'] },
        { id: 'report', name: 'Final Report', agent: 'coder', input: 'Compile all findings into a comprehensive, well-structured final report.', dependsOn: ['analyze'] },
      ],
      decisions: [],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Canvas helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeLevels(tasks: PipelineTask[]): PipelineTask[][] {
  const levels: PipelineTask[][] = [];
  const placed = new Set<string>();
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const level = remaining.filter((t) => t.dependsOn.every((d) => placed.has(d)));
    if (level.length === 0) {
      // Invalid graph (cycle or unresolved dependency): keep remaining tasks visible.
      levels.push(remaining);
      break;
    }
    level.forEach((t) => placed.add(t.id));
    remaining = remaining.filter((t) => !placed.has(t.id));
    levels.push(level);
  }
  return levels;
}

// Determine after which level-index a decision point naturally belongs
function decisionAfterLevel(dp: PipelineDecision, levels: PipelineTask[][]): number {
  let max = -1;
  levels.forEach((lvl, i) => {
    if (lvl.some((t) => dp.evaluates.includes(t.id))) max = Math.max(max, i);
  });
  return max;
}

function newTaskId(tasks: PipelineTask[]): string {
  const ids = new Set(tasks.map((t) => t.id));
  let n = tasks.length + 1;
  while (ids.has(`task_${n}`)) n++;
  return `task_${n}`;
}

function newDecisionId(decisions: PipelineDecision[]): string {
  const ids = new Set(decisions.map((d) => d.id));
  let n = decisions.length + 1;
  while (ids.has(`decide_${n}`)) n++;
  return `decide_${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Role / agent badge colors
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  orchestrator: 'bg-indigo-100 text-indigo-700',
  worker: 'bg-emerald-100 text-emerald-700',
  reviewer: 'bg-orange-100 text-orange-700',
  decider: 'bg-purple-100 text-purple-700',
};

function agentColor(agents: Agent[], key: string): string {
  const a = agents.find((x) => x.id === key);
  return a?.role ? (ROLE_COLORS[a.role] ?? 'bg-zinc-100 text-zinc-600') : 'bg-zinc-100 text-zinc-600';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main PipelinePage component (routing between list / editor / run)
// ─────────────────────────────────────────────────────────────────────────────

type View = 'list' | 'editor' | 'run';

export function PipelinePage({ agents }: { agents: Agent[] }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('list');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Pipeline | null>(null);
  const [running, setRunning] = useState<Pipeline | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [runAwaitingReview, setRunAwaitingReview] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setPipelines(await api.getPipelines());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleNew = () => {
    setEditing({ id: '', name: t('pipeline.newPipelineName'), description: '', tasks: [], decisions: [] });
    setView('editor');
  };

  const handleFromTemplate = (tpl: (typeof TEMPLATES)[0]) => {
    setEditing({ id: '', ...tpl.pipeline });
    setView('editor');
  };

  const handleEdit = (p: Pipeline) => { setEditing(p); setView('editor'); };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete pipeline "${id}"?`)) return;
    try {
      await api.deletePipeline(id);
      showToast(`Pipeline "${id}" deleted`);
      load();
    } catch (e) { showToast((e as Error).message, false); }
  };

  const handleSave = async (p: Pipeline) => {
    try {
      const { id, ...rest } = p;
      const exists = pipelines.some((x) => x.id === id);
      if (exists) {
        await api.updatePipeline(id, rest);
        showToast(`Saved "${p.name}"`);
      } else {
        await api.createPipeline(rest);
        showToast(`Created "${p.name}"`);
      }
      await load();
      setView('list');
    } catch (e) { showToast((e as Error).message, false); }
  };

  const handleRun = (p: Pipeline) => { setRunning(p); setRunActive(true); setRunAwaitingReview(false); setView('run'); };

  const handleRunBack = () => { setView('list'); };
  const handleRunDone = () => { setRunActive(false); setRunAwaitingReview(false); };
  const handleDismissRun = () => { if (runAwaitingReview) return; setRunning(null); setRunActive(false); };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (view === 'editor' && editing) {
    return (
      <PipelineEditor
        pipeline={editing}
        agents={agents}
        onSave={handleSave}
        onRun={handleRun}
        onBack={() => setView('list')}
      />
    );
  }

  // RunView is kept mounted (hidden) to preserve SSE connection & state
  return (
    <>
      {running && (
        <div className={view === 'run' ? '' : 'hidden'}>
          <RunView
            pipeline={running}
            onBack={handleRunBack}
            onDone={handleRunDone}
            onReviewStateChange={(awaiting) => {
              setRunAwaitingReview(awaiting);
              if (awaiting) setView('run');
            }}
          />
        </div>
      )}
      {view === 'list' && (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto px-5 py-8">
        {/* Running pipeline banner */}
        {running && (
          <div className={`mb-6 flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
            runAwaitingReview
              ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
              : 'border-indigo-200 bg-indigo-50 hover:border-indigo-300'
          }`} onClick={() => setView('run')}>
            <span className={`shrink-0 w-2 h-2 rounded-full ${
              runAwaitingReview ? 'bg-amber-500 animate-pulse' : runActive ? 'bg-indigo-500 animate-pulse' : 'bg-emerald-500'
            }`} />
            <div className="flex-1 min-w-0">
              <span className={`text-xs font-semibold ${runAwaitingReview ? 'text-amber-700' : 'text-indigo-700'}`}>{running.name}</span>
              <span className={`ml-2 text-[10px] ${runAwaitingReview ? 'text-amber-500' : 'text-indigo-400'}`}>
                {runAwaitingReview ? '⏸ Awaiting Review' : runActive ? 'Running...' : 'Completed'}
              </span>
            </div>
            <span className={`text-xs font-medium ${runAwaitingReview ? 'text-amber-600' : 'text-indigo-500'}`}>
              {runAwaitingReview ? 'Review →' : 'View →'}
            </span>
            {!runAwaitingReview && (
              <button
                onClick={(e) => { e.stopPropagation(); handleDismissRun(); }}
                className="text-indigo-300 hover:text-indigo-500 transition-colors p-0.5"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            )}
          </div>
        )}

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-800">{t('pipeline.heading')}</h1>
            <p className="mt-0.5 text-xs text-zinc-400">{t('pipeline.subheading')}</p>
          </div>
          <button
            onClick={handleNew}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
          >
            <PlusIcon />{t('pipeline.newPipeline')}
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16"><Spinner /></div>
        )}

        {!loading && error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {error} <button onClick={load} className="ml-2 underline">{t('pipeline.retry')}</button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Templates */}
            {pipelines.length === 0 && (
              <div className="mb-8">
                <p className="mb-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">{t('pipeline.startFromTemplate')}</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleFromTemplate(t)}
                      className="group flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-4 text-left hover:border-indigo-300 hover:shadow-sm transition-all"
                    >
                      <span className="text-2xl">{t.icon}</span>
                      <span className="text-sm font-semibold text-zinc-800 group-hover:text-indigo-700 transition-colors">{t.name}</span>
                      <span className="text-xs text-zinc-400 leading-relaxed">{t.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Pipeline list */}
            {pipelines.length > 0 && (
              <>
                <div className="mb-5">
                  <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    {pipelines.length} pipeline{pipelines.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {pipelines.map((p) => (
                    <PipelineCard
                      key={p.id}
                      pipeline={p}
                      onEdit={() => handleEdit(p)}
                      onDelete={() => handleDelete(p.id)}
                      onRun={() => handleRun(p)}
                    />
                  ))}
                  {/* Add another tile */}
                  <button
                    onClick={handleNew}
                    className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 bg-transparent py-8 text-zinc-300 hover:border-indigo-300 hover:text-indigo-400 transition-all"
                  >
                    <PlusIcon className="w-5 h-5" />
                    <span className="text-xs font-medium">{t('pipeline.newPipeline')}</span>
                  </button>
                </div>
                {/* Templates section (always visible) */}
                <div className="mt-10">
                  <p className="mb-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">{t('pipeline.templates')}</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => handleFromTemplate(t)}
                        className="group flex items-start gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left hover:border-indigo-300 hover:shadow-sm transition-all"
                      >
                        <span className="text-xl mt-0.5 shrink-0">{t.icon}</span>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-zinc-700 group-hover:text-indigo-700">{t.name}</div>
                          <div className="mt-0.5 text-xs text-zinc-400 line-clamp-2">{t.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-xl ${toast.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-600'}`}>
          {toast.ok ? '✓ ' : '✗ '}{toast.msg}
        </div>
      )}
    </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PipelineCard
// ─────────────────────────────────────────────────────────────────────────────

function PipelineCard({
  pipeline, onEdit, onDelete, onRun }: {
  pipeline: Pipeline;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm transition-all">
      <div className="flex-1 p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-zinc-800 leading-tight">{pipeline.name}</h3>
          <span className="shrink-0 text-xs text-zinc-400 font-mono-custom">{pipeline.id}</span>
        </div>
        {pipeline.description && (
          <p className="text-xs text-zinc-400 mb-3 line-clamp-2">{pipeline.description}</p>
        )}
        <div className="flex flex-wrap gap-1.5 mt-2">
          <span className="inline-flex items-center gap-1 rounded-md bg-zinc-50 border border-zinc-100 px-2 py-0.5 text-xs text-zinc-500">
            <NodeIcon /> {pipeline.tasks.length} step{pipeline.tasks.length !== 1 ? 's' : ''}
          </span>
          {pipeline.decisions.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-100 px-2 py-0.5 text-xs text-amber-600">
              ⬡ {pipeline.decisions.length} decision{pipeline.decisions.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3">
        <button onClick={onRun} className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors">
          ▶ {t('pipeline.run')}
        </button>
        <button onClick={onEdit} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors">
          {t('common.edit')}
        </button>
        <button onClick={onDelete} className="rounded-lg border border-red-100 px-3 py-1.5 text-xs font-medium text-red-400 hover:border-red-300 hover:text-red-500 transition-colors">
          {t('common.del')}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PipelineEditor
// ─────────────────────────────────────────────────────────────────────────────

function PipelineEditor({
  pipeline, agents, onSave, onRun, onBack }: {
  pipeline: Pipeline;
  agents: Agent[];
  onSave: (p: Pipeline) => Promise<void>;
  onRun: (p: Pipeline) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Pipeline>(() => ({
    ...pipeline,
    tasks: pipeline.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] })),
    decisions: pipeline.decisions.map((d) => ({ ...d, evaluates: [...d.evaluates] })),
  }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(!pipeline.id); // new pipelines have no ID yet
  const [saving, setSaving] = useState(false);
  const [showWorkspaceInput, setShowWorkspaceInput] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceValidating, setWorkspaceValidating] = useState(false);

  const update = useCallback((fn: (p: Pipeline) => Pipeline) => {
    setDraft((prev) => fn(prev));
    setIsDirty(true);
  }, []);

  const selectedTask = draft.tasks.find((t) => t.id === selectedId);
  const selectedDecision = draft.decisions.find((d) => d.id === selectedId);

  const handleAddTask = () => {
    const id = newTaskId(draft.tasks);
    
    // Auto-depend on the last task in the pipeline for convenience (creates sequential flow by default)
    let dependsOn: string[] = [];
    if (draft.tasks.length > 0) {
      dependsOn = [draft.tasks[draft.tasks.length - 1].id];
    }

    const task: PipelineTask = { id, name: t('step.defaultName'), agent: agents[0]?.id ?? '', input: '', dependsOn };
    update((p) => ({ ...p, tasks: [...p.tasks, task] }));
    setSelectedId(id);
  };

  const handleAddDecision = () => {
    const id = newDecisionId(draft.decisions);
    const dec: PipelineDecision = {
      id,
      name: 'Quality Gate',
      agent: agents.find((a) => a.role === 'decider')?.id ?? agents[0]?.id ?? '',
      evaluates: draft.tasks.length > 0 ? [draft.tasks[draft.tasks.length - 1].id] : [],
      maxRetries: 2,
    };
    update((p) => ({ ...p, decisions: [...p.decisions, dec] }));
    setSelectedId(id);
  };

  const handleDeleteNode = (id: string) => {
    update((p) => ({
      ...p,
      tasks: p.tasks.filter((t) => t.id !== id).map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((d) => d !== id),
      })),
      decisions: p.decisions.filter((d) => d.id !== id).map((d) => ({
        ...d,
        evaluates: d.evaluates.filter((e) => e !== id),
      })),
    }));
    setSelectedId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };

  const handleWorkspaceDone = async () => {
    const ws = draft.workspace?.trim();
    if (!ws) {
      // Empty = clear workspace
      setWorkspaceError(null);
      setShowWorkspaceInput(false);
      return;
    }
    setWorkspaceValidating(true);
    setWorkspaceError(null);
    try {
      await api.validateWorkspace(ws);
      setWorkspaceError(null);
      setShowWorkspaceInput(false);
    } catch (e) {
      setWorkspaceError((e as Error).message);
    } finally {
      setWorkspaceValidating(false);
    }
  };

  const levels = computeLevels(draft.tasks);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-white border-b border-zinc-200">
        <div className="mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 hover:text-zinc-700 flex items-center gap-1.5 text-xs transition-colors shrink-0">
            <ChevronLeftIcon /> {t('common.back')}
          </button>
          <div className="w-px h-4 bg-zinc-200 shrink-0" />
          <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
            <div className="flex flex-col gap-0.5 min-w-0">
              <input
                className="text-sm font-semibold text-zinc-800 bg-transparent outline-none border-b border-transparent hover:border-zinc-300 focus:border-indigo-400 transition-colors w-48 truncate"
                value={draft.name}
                {...{ placeholder: t('pipeline.namePlaceholder') }}
                onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
              />
              {draft.id && (
                <span className="text-[10px] text-zinc-400 font-mono-custom">{draft.id}</span>
              )}
            </div>

            {showWorkspaceInput ? (
              <div className="flex flex-col gap-1 min-w-[280px] max-w-[520px] w-full sm:w-auto">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wide shrink-0">Workspace</span>
                  <input
                    className={`flex-1 min-w-0 text-xs text-zinc-700 bg-white outline-none rounded border px-2 py-1.5 font-mono placeholder-zinc-300 focus:ring-1 transition-all ${workspaceError ? 'border-red-400 focus:border-red-400 focus:ring-red-100' : 'border-zinc-200 focus:border-indigo-400 focus:ring-indigo-100'}`}
                    value={draft.workspace ?? ''}
                    placeholder="/path/to/project"
                    onChange={(e) => { setWorkspaceError(null); update((p) => ({ ...p, workspace: e.target.value || undefined })); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleWorkspaceDone(); if (e.key === 'Escape') { setShowWorkspaceInput(false); setWorkspaceError(null); } }}
                  />
                  <button
                    onClick={handleWorkspaceDone}
                    disabled={workspaceValidating}
                    className="text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-50 transition-colors shrink-0"
                    title="Done"
                  >
                    {workspaceValidating ? '…' : 'Done'}
                  </button>
                </div>
                {workspaceError && (
                  <span className="text-[11px] text-red-500 pl-[68px]">{workspaceError}</span>
                )}
              </div>
            ) : (
              <button
                onClick={() => { setShowWorkspaceInput(true); setWorkspaceError(null); }}
                className="max-w-[420px] truncate rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] text-zinc-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                title={draft.workspace?.trim() ? draft.workspace : 'Set workspace path'}
              >
                {draft.workspace?.trim() ? `Workspace: ${draft.workspace}` : '+ Workspace'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onRun(draft)}
              disabled={!draft.id}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ▶ {t('pipeline.run')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t('pipeline.saving') : t('pipeline.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Body: canvas + inspector */}
      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <div
          className="flex-1 overflow-auto p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
        >
          <div className="mx-auto">
            {/* Description row */}
            <div className="mb-4">
              <input
                className="w-full text-xs text-zinc-500 bg-transparent outline-none placeholder-zinc-300 border-b border-transparent hover:border-zinc-200 focus:border-indigo-300 transition-colors"
                value={draft.description ?? ''}
                {...{ placeholder: t('pipeline.descPlaceholder') }}
                onChange={(e) => update((p) => ({ ...p, description: e.target.value }))}
              />
            </div>

            {draft.tasks.length === 0 && draft.decisions.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border-2 border-dashed border-zinc-200">
                <div className="text-3xl mb-3 opacity-30">◈</div>
                <p className="text-sm font-medium text-zinc-400 mb-1">{t('pipeline.emptyTitle')}</p>
                <p className="text-xs text-zinc-300 mb-5">{t('pipeline.emptyHint')}</p>
              </div>
            )}

            {/* Render levels */}
            {levels.map((level, levelIdx) => (
              <div key={levelIdx}>
                {/* Level row */}
                <div className="flex gap-3 justify-center flex-wrap">
                  {level.map((task) => (
                    <CanvasTaskNode
                      key={task.id}
                      task={task}
                      agents={agents}
                      isSelected={selectedId === task.id}
                      onClick={() => setSelectedId(task.id)}
                    />
                  ))}
                </div>

                {/* Decision points that evaluate tasks from this level */}
                {draft.decisions
                  .filter((dp) => decisionAfterLevel(dp, levels) === levelIdx)
                  .map((dp) => (
                    <div key={dp.id} className="flex flex-col items-center">
                      <FlowArrow />
                      <CanvasDecisionNode
                        decision={dp}
                        isSelected={selectedId === dp.id}
                        onClick={() => setSelectedId(dp.id)}
                      />
                    </div>
                  ))}

                {/* Arrow to next level */}
                {levelIdx < levels.length - 1 && <FlowArrow />}
              </div>
            ))}

            {/* Orphaned decisions (evaluates unknown tasks) */}
            {draft.decisions
              .filter((dp) => decisionAfterLevel(dp, levels) === -1)
              .map((dp) => (
                <div key={dp.id} className="flex flex-col items-center mt-4">
                  <CanvasDecisionNode
                    decision={dp}
                    isSelected={selectedId === dp.id}
                    onClick={() => setSelectedId(dp.id)}
                  />
                </div>
              ))}

            {/* Add buttons */}
            <div className="flex gap-3 justify-center mt-6">
              <button
                onClick={handleAddTask}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-4 py-2.5 text-xs font-medium text-zinc-500 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
              >
                <PlusIcon /> {t('pipeline.addStep').replace('+ ', '')}
              </button>
              <button
                onClick={handleAddDecision}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-amber-200 px-4 py-2.5 text-xs font-medium text-amber-500 hover:border-amber-400 hover:bg-amber-50 transition-all"
              >
                <PlusIcon /> {t('pipeline.addDecision').replace('+ ', '')}
              </button>
            </div>
          </div>
        </div>

        {/* Inspector */}
        <div className="w-80 shrink-0 border-l border-zinc-200 bg-white overflow-y-auto">
          {selectedTask && (
            <TaskInspector
              task={selectedTask}
              allTasks={draft.tasks}
              agents={agents}
              hasWorkspace={!!draft.workspace?.trim()}
              onChange={(updated) => {
                update((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === updated.id ? updated : t)) }));
              }}
              onDelete={() => handleDeleteNode(selectedTask.id)}
            />
          )}
          {selectedDecision && (
            <DecisionInspector
              decision={selectedDecision}
              allTasks={draft.tasks}
              agents={agents}
              onChange={(updated) => {
                update((p) => ({ ...p, decisions: p.decisions.map((d) => (d.id === updated.id ? updated : d)) }));
              }}
              onDelete={() => handleDeleteNode(selectedDecision.id)}
            />
          )}
          {!selectedTask && !selectedDecision && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
              <div className="text-3xl mb-3 opacity-20">⚙</div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {t('common.clickToConfig')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas nodes
// ─────────────────────────────────────────────────────────────────────────────

function CanvasTaskNode({ task, agents, isSelected, onClick }: {
  task: PipelineTask;
  agents: Agent[];
  isSelected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const isMulti = Array.isArray(task.agent);
  const agentKeys = isMulti ? (task.agent as string[]) : [task.agent as string];
  const firstKey = agentKeys[0] ?? '';
  const firstAgent = agents.find((a) => a.id === firstKey);
  const color = agentColor(agents, firstKey);

  return (
    <button
      onClick={onClick}
      className={`group relative w-48 flex flex-col gap-1.5 rounded-xl border bg-white px-4 py-3 text-left shadow-sm hover:shadow-md transition-all ${
        isSelected ? 'border-indigo-400 ring-2 ring-indigo-200 shadow-indigo-100' : 'border-zinc-200'
      } ${isMulti ? 'ring-1 ring-offset-2 ring-zinc-100' : ''}`}
      style={isMulti ? { boxShadow: '3px 3px 0 #e4e4e7, 6px 6px 0 #f4f4f5' } : undefined}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-mono-custom text-zinc-400 truncate">{task.id}</span>
        {isMulti ? (
          <span className="shrink-0 rounded-md bg-indigo-100 text-indigo-700 px-1.5 py-0.5 text-xs font-semibold">
            ×{agentKeys.length} workers
          </span>
        ) : (
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium ${color}`}>
            {firstAgent?.name || firstKey || '—'}
          </span>
        )}
      </div>
      <p className="text-xs font-semibold text-zinc-800 truncate">
        {task.name}
        {task.requiresReview && <span className="ml-1 text-amber-500 text-[10px]" title={t('step.humanReviewBadgeTitle')}>⏸</span>}
      </p>
      {task.input && (
        <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">{task.input}</p>
      )}
      {task.dependsOn.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {task.dependsOn.map((d) => (
            <span key={d} className="rounded-sm bg-zinc-100 text-zinc-500 px-1 text-[10px]">←{d}</span>
          ))}
        </div>
      )}
    </button>
  );
}

function CanvasDecisionNode({ decision, isSelected, onClick }: {
  decision: PipelineDecision;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-72 flex flex-col gap-1.5 rounded-xl border bg-amber-50 px-4 py-3 text-left shadow-sm hover:shadow-md transition-all ${
        isSelected ? 'border-amber-400 ring-2 ring-amber-200' : 'border-amber-200'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-amber-500 text-lg leading-none">⬡</span>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-semibold text-amber-800 truncate block">
            {decision.name ?? decision.id}
          </span>
          <span className="text-xs text-amber-600 font-mono-custom">{decision.id}</span>
        </div>
      </div>
      <div className="text-xs text-amber-700 space-y-0.5">
        <div>agent: <span className="font-medium">{decision.agent || '—'}</span></div>
        <div>evaluates: <span className="font-medium">{decision.evaluates.join(', ') || '—'}</span></div>
        <div>max retries: <span className="font-medium">{decision.maxRetries}</span></div>
      </div>
    </button>
  );
}

function FlowArrow() {
  return (
    <div className="flex justify-center my-2">
      <svg width="2" height="24" viewBox="0 0 2 24" fill="none">
        <line x1="1" y1="0" x2="1" y2="18" stroke="#d4d4d8" strokeWidth="1.5" strokeDasharray="4 2" />
        <path d="M1 24 L-3 16 L5 16 Z" fill="#d4d4d8" />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspectors
// ─────────────────────────────────────────────────────────────────────────────

function TaskInspector({
  task, allTasks, agents, hasWorkspace, onChange, onDelete }: {
  task: PipelineTask;
  allTasks: PipelineTask[];
  agents: Agent[];
  hasWorkspace: boolean;
  onChange: (t: PipelineTask) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isMulti = Array.isArray(task.agent);
  const agentKeys: string[] = isMulti ? [...(task.agent as string[])] : [task.agent as string];

  const isCliAgent = (agentId: string): boolean => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const visited = new Set<string>();
    let current = byId.get(agentId);
    while (current) {
      if (current.provider?.type) return current.provider.type === 'cli';
      if (!current.baseAgent || visited.has(current.baseAgent)) return false;
      visited.add(current.baseAgent);
      current = byId.get(current.baseAgent);
    }
    return false;
  };

  // gitDiff is mainly for API-model review tasks; CLI tasks can read git/files directly.
  const isCliOnlyTask = agentKeys.length > 0 && agentKeys.every((k) => isCliAgent(k));
  const canUseGitDiff = hasWorkspace && !isCliOnlyTask;

  const taskIndex = allTasks.findIndex((x) => x.id === task.id);
  const availableDependencyTasks = taskIndex > 0 ? allTasks.slice(0, taskIndex) : [];
  const availableDependencyIds = new Set(availableDependencyTasks.map((x) => x.id));

  const setField = <K extends keyof PipelineTask>(key: K, val: PipelineTask[K]) => {
    if (key === 'dependsOn') {
      const nextDeps = (val as string[]).filter((depId) => availableDependencyIds.has(depId));
      onChange({ ...task, dependsOn: nextDeps });
      return;
    }
    onChange({ ...task, [key]: val });
  };

  useEffect(() => {
    // Auto-clean invalid forward dependencies to avoid cycles and hidden canvas rows.
    const sanitized = task.dependsOn.filter((depId) => availableDependencyIds.has(depId));
    if (sanitized.length !== task.dependsOn.length) {
      onChange({ ...task, dependsOn: sanitized });
    }
  }, [availableDependencyIds, onChange, task]);

  useEffect(() => {
    if (isCliOnlyTask && task.gitDiff) {
      onChange({ ...task, gitDiff: false });
    }
  }, [isCliOnlyTask, onChange, task]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">{t('step.configTitle')}</h3>
        <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 transition-colors">
          {t('common.delete')}
        </button>
      </div>

      <Field label={t('step.fieldId')}>
        <input className={inputCls} value={task.id} readOnly disabled />
      </Field>

      <Field label={t('step.fieldName')}>
        <input className={inputCls} value={task.name} onChange={(e) => setField('name', e.target.value)} />
      </Field>

      {/* Agent type toggle */}
      <Field label={t('step.fieldAgentMode')}>
        <div className="flex rounded-lg border border-zinc-200 overflow-hidden text-xs">
          {(['single', 'parallel'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === 'single') setField('agent', agentKeys[0] ?? '');
                else setField('agent', agentKeys.length > 1 ? agentKeys : [agentKeys[0] ?? '', agentKeys[0] ?? '']);
              }}
              className={`flex-1 py-1.5 font-medium transition-colors ${
                (mode === 'parallel') === isMulti
                  ? 'bg-indigo-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-50'
              }`}
            >
              {mode === 'single' ? t('step.modeSingle') : t('step.modeParallel')}
            </button>
          ))}
        </div>
      </Field>

      {isMulti ? (
        <Field label={t('step.fieldWorkers', { count: agentKeys.length })} hint={t('step.workersHint')}>
          <div className="space-y-1.5">
            {agentKeys.map((key, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <select
                  className={`flex-1 ${inputCls}`}
                  value={key}
                  onChange={(e) => {
                    const next = [...agentKeys];
                    next[idx] = e.target.value;
                    setField('agent', next);
                  }}
                >
                  <option value="">{t('step.selectAgent')}</option>
                  {agents.filter((a) => !!a.role).map((a) => (
                    <option key={a.id} value={a.id}>{a.name || a.id} [{t(`role.${a.role}`)}]</option>
                  ))}
                </select>
                {agentKeys.length > 1 && (
                  <button
                    onClick={() => setField('agent', agentKeys.filter((_, i) => i !== idx))}
                    className="text-zinc-300 hover:text-red-400 transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => setField('agent', [...agentKeys, agentKeys[0] ?? ''])}
              className="text-xs text-indigo-500 hover:text-indigo-700 transition-colors"
            >
              {t('step.addWorker')}
            </button>
          </div>
        </Field>
      ) : (
        <Field label={t('step.fieldAgent')}>
          <select
            className={inputCls}
            value={task.agent as string}
            onChange={(e) => setField('agent', e.target.value)}
          >
            <option value="">{t('step.selectAgent')}</option>
            {agents.filter((a) => !!a.role).map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id} [{t(`role.${a.role}`)}]</option>
            ))}
          </select>
        </Field>
      )}

      <Field label={t('step.fieldInstruction')} hint={t('step.instructionHint')}>
        <textarea
          className={`${inputCls} resize-y`}
          rows={4}
          value={task.input}
          onChange={(e) => setField('input', e.target.value)}
          {...{ placeholder: t('step.instructionPlaceholder') }}
        />
      </Field>

      <Field label={t('step.fieldDependsOn')} hint={t('step.dependsOnHint')}>
        <div className="space-y-1">
          {availableDependencyTasks.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={task.dependsOn.includes(t.id)}
                onChange={(e) => {
                  const deps = e.target.checked
                    ? [...task.dependsOn, t.id]
                    : task.dependsOn.filter((d) => d !== t.id);
                  setField('dependsOn', deps);
                }}
              />
              <span className="font-mono-custom">{t.id}</span>
              <span className="text-zinc-400">{t.name}</span>
            </label>
          ))}
          {availableDependencyTasks.length === 0 && (
            <p className="text-xs text-zinc-300">{t('step.noOtherSteps')}</p>
          )}
        </div>
      </Field>

      {/* Requires Review toggle */}
      <Field label={t('step.humanReviewLabel')} hint={t('step.humanReviewHint')}>
        <label className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
          <input
            type="checkbox"
            className="rounded"
            checked={task.requiresReview ?? false}
            onChange={(e) => setField('requiresReview' as keyof PipelineTask, e.target.checked as never)}
          />
          <span>{t('step.humanReviewToggle')}</span>
        </label>
      </Field>

      {/* Git Diff toggle — only available when pipeline has a workspace configured */}
      {canUseGitDiff && (
        <Field label={t('step.gitDiffLabel')} hint={t('step.gitDiffHint')}>
          <label className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
            <input
              type="checkbox"
              className="rounded"
              checked={task.gitDiff ?? false}
              onChange={(e) => setField('gitDiff' as keyof PipelineTask, e.target.checked as never)}
            />
            <span>{t('step.gitDiffToggle')}</span>
          </label>
        </Field>
      )}
    </div>
  );
}

function DecisionInspector({
  decision, allTasks, agents, onChange, onDelete }: {
  decision: PipelineDecision;
  allTasks: PipelineTask[];
  agents: Agent[];
  onChange: (d: PipelineDecision) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const setField = <K extends keyof PipelineDecision>(key: K, val: PipelineDecision[K]) =>
    onChange({ ...decision, [key]: val });

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-amber-600 uppercase tracking-wider">{`⬡ ${t('decision.panelTitle', 'Decision Point')}`}</h3>
        <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 transition-colors">
          {t('common.delete')}
        </button>
      </div>

      <Field label={t('decision.fieldId')}>
        <input className={inputCls} value={decision.id} readOnly disabled />
      </Field>

      <Field label={t('decision.fieldName')}>
        <input
          className={inputCls}
          value={decision.name ?? ''}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="e.g. Quality Gate"
        />
      </Field>

      <Field label={t('decision.fieldDecider')} hint={t('decision.deciderHint')}>
        <select
          className={inputCls}
          value={decision.agent}
          onChange={(e) => setField('agent', e.target.value)}
        >
          <option value="">{t('step.selectAgent')}</option>
          {agents.filter((a) => !!a.role).map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id} [{t(`role.${a.role}`)}]</option>
          ))}
        </select>
      </Field>

      <Field label={t('decision.fieldEvaluates')} hint={t('decision.evaluatesHint')}>
        <div className="space-y-1">
          {allTasks.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={decision.evaluates.includes(t.id)}
                onChange={(e) => {
                  const evals = e.target.checked
                    ? [...decision.evaluates, t.id]
                    : decision.evaluates.filter((id) => id !== t.id);
                  setField('evaluates', evals);
                }}
              />
              <span className="font-mono-custom">{t.id}</span>
              <span className="text-zinc-400">{t.name}</span>
            </label>
          ))}
          {allTasks.length === 0 && <p className="text-xs text-zinc-300">{t('decision.noStepsYet')}</p>}
        </div>
      </Field>

      <Field label={t('decision.fieldMaxRetries')} hint={t('decision.maxRetriesHint')}>
        <input
          className={inputCls}
          type="number"
          min={1}
          max={10}
          value={decision.maxRetries}
          onChange={(e) => setField('maxRetries', Math.max(1, parseInt(e.target.value) || 1))}
        />
      </Field>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RunView — live SSE log
// ─────────────────────────────────────────────────────────────────────────────

export interface LogEntry {
  id: string;
  type: RunEventType;
  label: string;
  detail?: string;
  output?: string;
  outputs?: string[];                // per-worker outputs
  error?: string;
  streamContent?: string;
  agents?: string[];
  toolEvents?: ToolEvent[];          // flat merged (all workers)
  workerEvents?: ToolEvent[][];      // per-worker
  workerStatus?: ('running' | 'done' | 'error')[];
  startedAt?: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'decision' | 'awaiting_review' | 'pending';
  // Review fields
  requiresReview?: boolean;
  currentRound?: number;
  reviewPending?: boolean;
}

function appendTextChunk(base: string, chunk: string): string {
  if (!chunk) return base;
  if (!base) return chunk;
  if (base.endsWith('\n') || chunk.startsWith('\n')) return base + chunk;
  return `${base}\n${chunk}`;
}

function RunView({
  pipeline, onBack, onDone, onReviewStateChange }: { pipeline: Pipeline; onBack: () => void; onDone: () => void; onReviewStateChange: (awaiting: boolean) => void }) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<Record<string, { output: string; error?: string }>>({});
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const [modalOutput, setModalOutput] = useState<{ title: string; content: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const addEntry = (entry: LogEntry) => {
    setLog((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
      return [...prev, entry];
    });
  };

  const updateEntry = (id: string, patch: Partial<LogEntry>) => {
    setLog((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Only auto-scroll if user is already near the bottom (within 120px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [log]);

  const handleRun = async () => {
    if (!goal.trim()) return;
    setStarted(true);
    setLog([]);
    setResults({});
    setDone(false);
    setFatalError(null);

    try {
      await api.runPipeline(pipeline.id, goal, (type, data) => {
        const d = data as Record<string, unknown>;
        if (type === 'run:started' as RunEventType) {
          setActiveRunId(d.runId as string);
        } else if (type === 'task:start') {
          const agents = d.agents as string[];
          addEntry({
            id: d.taskId as string,
            type,
            label: `${d.taskName as string}`,
            detail: `Running via ${agents.join(', ')}`,
            output: '',
            agents,
            toolEvents: [],
            workerEvents: agents.map(() => []),
            workerStatus: agents.length > 1 ? agents.map(() => 'running') : undefined,
            startedAt: Date.now(),
            status: 'running',
          });
          setModalTaskId(d.taskId as string);
        } else if (type === 'task:tool_event') {
          const event = d.event as ToolEvent;
          const taskId = d.taskId as string;
          const workerIndex = (d.workerIndex as number) ?? 0;
          if (event) {
            setLog((prev) => prev.map((e) => {
              if (e.id !== taskId) return e;
              const newEvents = [...(e.toolEvents ?? []), event];
              // Per-worker tracking
              const newWorkerEvents = e.workerEvents ? e.workerEvents.map((w, i) => i === workerIndex ? [...w, event] : w) : [[event]];
              let newStream = e.streamContent ?? '';
              let newDetail = e.detail;
              if (event.type === 'tool_use') {
                // Don't update detail with tool_use summary — the timeline shows tools.
                // Just keep the previous detail to avoid flashing.
              } else if (event.type === 'tool_result') {
                // Keep quiet — timeline shows results.
              } else if (event.type === 'text' && event.content) {
                newStream = appendTextChunk(newStream, event.content);
                newDetail = '● streaming...';
              }
              return { ...e, toolEvents: newEvents, workerEvents: newWorkerEvents, streamContent: newStream, detail: newDetail };
            }));
          }
        } else if (type === 'worker:complete') {
          const workerIndex = (d.workerIndex as number) ?? 0;
          const error = d.error as string | undefined;
          setLog((prev) => prev.map((e) => {
            if (e.id !== (d.taskId as string)) return e;
            const newStatus = [...(e.workerStatus ?? (e.agents ?? []).map(() => 'running' as const))];
            newStatus[workerIndex] = error ? 'error' : 'done';
            return { ...e, workerStatus: newStatus };
          }));
        } else if (type === 'task:complete') {
          const error = d.error as string | undefined;
          const output = (d.output as string | undefined) ?? '';
          const outputs = d.outputs as string[] | undefined;
          setLog((prev) => prev.map((e) => e.id === (d.taskId as string)
            ? {
              ...e,
              status: error ? 'error' as const : 'done' as const,
              error,
              output,
              outputs,
              detail: error ? error : '✓ Completed',
              finishedAt: Date.now(),
            }
            : e
          ));
        } else if (type === 'decision:start') {
          addEntry({
            id: d.decisionId as string,
            type,
            label: `⬡ Decision — evaluating ${(d.evaluates as string[]).join(', ')}`,
            status: 'running',
          });
        } else if (type === 'decision:complete') {
          const action = d.action as string;
          const retrying = d.retrying as string[] | undefined;
          updateEntry(d.decisionId as string, {
            status: 'decision',
            detail: action === 'retry'
              ? `↺ RETRY [${retrying?.join(', ')}] — ${d.reason}`
              : `✓ CONTINUE — ${d.reason}`,
          });
        } else if (type === 'complete') {
          setResults(d.results as Record<string, { output: string; error?: string }>);
          const runId = d.runId as string | undefined;
          if (runId) setActiveRunId(runId);
          setDone(true);
          onDone();
        } else if (type === 'error') {
          setFatalError(d.message as string);
          setDone(true);
          onDone();
        } else if (type === 'review:pending') {
          const taskId = d.taskId as string;
          const round = (d.round as number) ?? 1;
          setLog((prev) => prev.map((e) => e.id === taskId
            ? { ...e, status: 'awaiting_review' as const, reviewPending: true, currentRound: round, detail: `⏸ Awaiting review (round ${round})` }
            : e
          ));
          // Switch from task detail modal to the review panel when human input is required.
          setModalTaskId(null);
          setReviewingTaskId(taskId);
          onReviewStateChange(true);
        } else if (type === 'review:submitted') {
          const taskId = d.taskId as string;
          const action = d.action as string;
          setLog((prev) => prev.map((e) => e.id === taskId
            ? { ...e, reviewPending: false, detail: action === 'approve' ? '✓ Approved — continuing' : `↻ Revising (feedback: ${(d.comment as string)?.slice(0, 50)}...)` }
            : e
          ));
          if (action === 'approve') {
            setReviewingTaskId(null);
            onReviewStateChange(false);
          }
        } else if (type === 'task:revision') {
          const taskId = d.taskId as string;
          const round = (d.round as number) ?? 2;
          setLog((prev) => prev.map((e) => e.id === taskId
            ? { ...e, status: 'running' as const, currentRound: round, reviewPending: false, detail: `↻ Revision round ${round}`, toolEvents: [], workerEvents: e.agents?.map(() => []) ?? [[]], streamContent: '' }
            : e
          ));
        } else if (type === 'task:rollback') {
          const toTaskId = d.toTaskId as string;
          setLog((prev) => prev.map((e) => e.id === toTaskId
            ? { ...e, status: 'pending' as const, detail: `↩ Rolling back — ${(d.reason as string)?.slice(0, 60)}` }
            : e
          ));
        }
      });
    } catch (e) {
      setFatalError((e as Error).message);
      setDone(true);
      onDone();
    }
  };

  const modalEntry = modalTaskId ? log.find((e) => e.id === modalTaskId) : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-white border-b border-zinc-200">
        <div className="mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 hover:text-zinc-700 flex items-center gap-1.5 text-xs transition-colors shrink-0">
            <ChevronLeftIcon /> Back
          </button>
          <div className="w-px h-4 bg-zinc-200 shrink-0" />
          <span className="text-sm font-semibold text-zinc-800 truncate">{pipeline.name}</span>
          <span className="text-xs text-zinc-400">{t('run.label')}</span>
        </div>
      </div>

      <div className="mx-auto w-full px-4 py-6 flex flex-col gap-6">
        {/* Goal input */}
        {!started && (
          <div className="bg-white rounded-xl border border-zinc-200 p-5">
            <h2 className="text-sm font-semibold text-zinc-800 mb-1">{t('run.goalTitle')}</h2>
            <p className="text-xs text-zinc-400 mb-4">
              {t('run.goalDesc')}
            </p>
            <textarea
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize-none"
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              {...{ placeholder: t('run.goalPlaceholder') }}
              autoFocus
            />
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleRun}
                disabled={!goal.trim()}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ▶ {t('run.startRun').replace('▶ ', '')}
              </button>
            </div>
          </div>
        )}

        {/* Pipeline diagram (compact) */}
        {started && (
          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="text-xs font-medium text-zinc-400 mb-3 uppercase tracking-wider">{t('run.goalLabel')}</div>
            <p className="text-sm text-zinc-700 leading-relaxed">{goal}</p>
          </div>
        )}

        {/* Live log */}
        {started && (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="border-b border-zinc-100 px-4 py-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-600">
                {done ? (fatalError ? t('run.failed') : t('run.complete')) : t('run.running')}
              </span>
              {!done && <Spinner />}
            </div>
            <div ref={logRef} className="divide-y divide-zinc-50 overflow-y-auto">
              {log.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  onOpenDetail={() => setModalTaskId(entry.id)}
                />
              ))}
              {log.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-zinc-300">{t('run.starting')}</div>
              )}
            </div>
          </div>
        )}

        {/* Review panel — shown when a task is awaiting review */}
        {reviewingTaskId && activeRunId && (() => {
          const entry = log.find((e) => e.id === reviewingTaskId);
          if (!entry || !entry.reviewPending) return null;
          return (
            <ReviewPanel
              runId={activeRunId}
              taskId={reviewingTaskId}
              taskName={entry.label}
              output={entry.output ?? entry.streamContent ?? ''}
              round={entry.currentRound ?? 1}
              pipeline={pipeline}
              onSubmitted={() => setReviewingTaskId(null)}
            />
          );
        })()}

        {/* Fatal error */}
        {fatalError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {t('run.error')}{fatalError}
          </div>
        )}

        {/* Results summary */}
        {done && !fatalError && Object.keys(results).length > 0 && (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="border-b border-zinc-100 px-4 py-3">
              <span className="text-xs font-semibold text-zinc-600">{t('run.results')}</span>
            </div>
            <div className="divide-y divide-zinc-50">
              {Object.entries(results).map(([taskId, r]) => (
                <div key={taskId} className="px-4 py-3 flex items-start gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${r.error ? 'bg-red-400' : 'bg-emerald-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono-custom text-zinc-700 font-semibold">{taskId}</span>
                      <span className="text-[10px] text-zinc-400">{(r.error ? r.error : r.output).length} chars</span>
                    </div>
                    <div className="max-h-24 overflow-hidden text-xs text-zinc-500 leading-relaxed">
                      <Markdown content={r.error ? `**Error:** ${r.error}` : r.output} />
                    </div>
                  </div>
                  <button
                    onClick={() => setModalOutput({ title: taskId, content: r.error ? `**Error:**\n\n\`\`\`\n${r.error}\`\`\`` : r.output })}
                    className="shrink-0 text-xs text-indigo-600 font-medium hover:text-indigo-800 transition-colors"
                  >
                    Full ↗
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Run again */}
        {done && (
          <div className="flex justify-center">
            <button
              onClick={() => { setStarted(false); setDone(false); setLog([]); setResults({}); setFatalError(null); }}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors"
            >
              Run Again
            </button>
          </div>
        )}
      </div>

      {/* Task detail modal */}
      {modalEntry && (
        <TaskDetailModal
          entry={modalEntry}
          onClose={() => setModalTaskId(null)}
        />
      )}

      {/* Output modal */}
      {modalOutput && (
        <OutputModal
          title={modalOutput.title}
          content={modalOutput.content}
          onClose={() => setModalOutput(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown renderer (shared)
// ─────────────────────────────────────────────────────────────────────────────

type ContentSection = { kind: 'markdown' | 'thinking'; content: string };

function normalizeMixedContent(input: string): string {
  let text = input.replace(/\r\n/g, '\n');
  const escapedNewlineCount = (text.match(/\\n/g) ?? []).length;
  const hasRealNewline = text.includes('\n');

  if (escapedNewlineCount > 0 && (!hasRealNewline || escapedNewlineCount >= 2)) {
    text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  return text;
}

function splitThinkingSections(input: string): ContentSection[] {
  const content = normalizeMixedContent(input);
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

function Markdown({ content, className }: { content: string; className?: string }) {
  return <MarkdownWithThinking content={content} className={className} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReviewPanel — human review UI for paused tasks
// ─────────────────────────────────────────────────────────────────────────────

function ReviewPanel({ runId, taskId, taskName, output, round, pipeline, onSubmitted }: {
  runId: string;
  taskId: string;
  taskName: string;
  output: string;
  round: number;
  pipeline: Pipeline;
  onSubmitted: () => void;
}) {
  const [comment, setComment] = useState('');
  const [action, setAction] = useState<'approve' | 'revise'>('approve');
  const [targetTaskId, setTargetTaskId] = useState(taskId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Find upstream tasks for rollback target selector
  const upstreamTasks = pipeline.tasks.filter((t) => t.id !== taskId);

  const handleSubmit = async () => {
    if (action === 'revise' && !comment.trim()) {
      setError('Please provide feedback when requesting a revision.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.submitReview(
        runId,
        taskId,
        action,
        comment.trim(),
        action === 'revise' && targetTaskId !== taskId ? targetTaskId : undefined,
      );
      onSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border-2 border-amber-300 overflow-hidden shadow-sm">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-2">
        <span className="text-amber-600 text-sm">⏸</span>
        <span className="text-xs font-semibold text-amber-800">Review: {taskName}</span>
        <span className="text-[10px] text-amber-500 ml-auto">Round {round}</span>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Output preview */}
        {output && (
          <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-50 p-3 text-xs">
            <Markdown content={output} />
          </div>
        )}

        {/* Action selector */}
        <div className="flex gap-2">
          <button
            onClick={() => setAction('approve')}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${
              action === 'approve'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                : 'bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300'
            }`}
          >
            ✓ Approve & Continue
          </button>
          <button
            onClick={() => setAction('revise')}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${
              action === 'revise'
                ? 'bg-amber-50 border-amber-300 text-amber-700'
                : 'bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300'
            }`}
          >
            ↻ Request Revision
          </button>
        </div>

        {/* Comment / feedback */}
        <textarea
          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize-none"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={action === 'approve' ? 'Optional comment...' : 'Describe what needs to change...'}
        />

        {/* Rollback target (only for revise) */}
        {action === 'revise' && upstreamTasks.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500 shrink-0">Revise target:</span>
            <select
              value={targetTaskId}
              onChange={(e) => setTargetTaskId(e.target.value)}
              className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-indigo-400"
            >
              <option value={taskId}>Current task ({taskId})</option>
              {upstreamTasks.map((t) => (
                <option key={t.id} value={t.id}>↩ {t.name} ({t.id})</option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}

        {/* Submit */}
        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className={`rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
              action === 'approve'
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {submitting ? 'Submitting...' : action === 'approve' ? '✓ Approve' : '↻ Submit Revision'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LogRow
// ─────────────────────────────────────────────────────────────────────────────

function LogRow({ entry, onOpenDetail }: {
  entry: LogEntry;
  onOpenDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCallCount = (entry.toolEvents ?? []).filter((e) => e.type === 'tool_use').length;
  const icons: Record<LogEntry['status'], string> = { running: '◌', done: '✓', error: '✗', decision: '⬡', awaiting_review: '⏸', pending: '↩' };
  const colors: Record<LogEntry['status'], string> = { running: 'text-zinc-400', done: 'text-emerald-500', error: 'text-red-500', decision: 'text-amber-500', awaiting_review: 'text-amber-500', pending: 'text-zinc-300' };
  const durationMs = entry.startedAt ? (entry.finishedAt ?? Date.now()) - entry.startedAt : undefined;
  const previewText = entry.status === 'running'
    ? '● streaming...'
    : (entry.status === 'done'
      ? (entry.output?.split('\n')[0] || entry.detail?.split('\n')[0])
      : entry.detail?.split('\n')[0]);

  return (
    <div>
      <div className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors">
        <button onClick={() => setExpanded((e) => !e)} className="flex-1 min-w-0 flex items-start gap-3 text-left">
          <span className={`shrink-0 mt-0.5 text-sm ${colors[entry.status]} ${entry.status === 'running' ? 'animate-pulse' : ''}`}>
            {icons[entry.status]}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-zinc-800">{entry.label}</p>
              {entry.agents && entry.agents.length > 0 && (
                <span className="text-[10px] text-zinc-400 font-mono">{entry.agents.join(', ')}</span>
              )}
            </div>
            {previewText && (
              <p className="text-xs text-zinc-400 truncate mt-0.5">{previewText}</p>
            )}
          </div>
          <ChevronRightIcon className={`shrink-0 w-3 h-3 mt-1 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>

        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          {toolCallCount > 0 && (
            <span className="rounded-md bg-indigo-50 text-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold">🔧 {toolCallCount}</span>
          )}
          {durationMs != null && durationMs > 0 && (
            <span className="text-[10px] text-zinc-400">{formatDurationShort(durationMs)}</span>
          )}
          <button onClick={onOpenDetail} className="text-xs text-indigo-600 font-medium ml-2 hover:text-indigo-800">
            Detail ↗
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-zinc-100 px-4 py-3 bg-white">
          <TaskDetailContent entry={entry} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskDetailModal — modal overlay with tabs for parallel workers + timeline
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Bash: '⬛', bash: '⬛', Read: '📄', ReadFile: '📄', read_file: '📄',
  Write: '✏️', WriteFile: '✏️', write_file: '✏️',
  WebSearch: '🔍', Search: '🔍', search: '🔍',
  Edit: '✏️', MultiEdit: '✏️', edit_file: '✏️',
  Glob: '📁', LS: '📁', list_dir: '📁',
  Grep: '🔎', grep_search: '🔎',
};

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

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

type TimelineItem = { type: 'tool'; use: ToolEvent; result?: ToolEvent; index: number }
  | { type: 'text'; content: string; index: number };

function buildTimeline(events: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let idx = 0;
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === ev.toolUseId);
      items.push({ type: 'tool', use: ev, result, index: idx++ });
    } else if (ev.type === 'text') {
      const last = items[items.length - 1];
      if (last && last.type === 'text') { last.content += ev.content ?? ''; }
      else { items.push({ type: 'text', content: ev.content ?? '', index: idx++ }); }
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
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-2 py-1 text-left group">
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
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-2 py-1 text-left">
          <span className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold bg-indigo-100 text-indigo-700">Agent</span>
          <span className="text-xs text-zinc-500 truncate flex-1">{preview}{item.content.length > 80 ? '...' : ''}</span>
          <ChevronRightIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded && (
          <div className="mt-2 pl-1">
            <Markdown content={item.content} className="text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerTimeline({ events, status }: { events: ToolEvent[]; status: LogEntry['status'] }) {
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
    <div ref={scrollRef} className="overflow-y-auto max-h-[55vh] pr-1">
      {timeline.map((item, i) =>
        item.type === 'tool'
          ? <TimelineToolItem key={`t-${item.use.toolUseId ?? i}`} item={item} idx={i} />
          : <TimelineTextItem key={`x-${i}`} item={item} />
      )}
    </div>
  );
}


function getEntryWorkers(entry: LogEntry): ToolEvent[][] {
  return entry.workerEvents && entry.workerEvents.length > 1
    ? entry.workerEvents
    : [entry.toolEvents ?? []];
}

function getEntryOutput(entry: LogEntry): string {
  if (entry.output && entry.output.trim()) return entry.output;
  if (entry.streamContent && entry.streamContent.trim()) return entry.streamContent;
  return '';
}

function getEntryDetail(entry: LogEntry): string {
  if (entry.status === 'error') {
    return entry.error ?? entry.detail ?? '';
  }
  if (entry.status === 'decision') {
    return entry.detail ?? '';
  }
  if (entry.status === 'running') {
    if (entry.detail === '● streaming...') return '';
    return entry.detail ?? '';
  }
  return '';
}

function TaskDetailContent({ entry, fullHeight = false }: { entry: LogEntry; fullHeight?: boolean }) {
  // Keep full timeline details even after completion to avoid losing execution context.
  const detailEventMode = 'all';
  return (
    <TaskDetailShared
      workers={getEntryWorkers(entry)}
      agents={entry.agents}
      status={entry.status === 'awaiting_review' || entry.status === 'pending' ? 'running' : entry.status}
      detail={getEntryDetail(entry)}
      output={getEntryOutput(entry)}
      outputs={entry.outputs}
      workerStatus={entry.workerStatus}
      fullHeight={fullHeight}
      detailEventMode={detailEventMode}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OutputModal — fullscreen dialog for viewing task output as markdown
// ─────────────────────────────────────────────────────────────────────────────

function OutputModal({ title, content, onClose }: { title: string; content: string; onClose: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="border-b border-zinc-100 px-5 py-4 flex items-center justify-between shrink-0 sticky top-0 z-10 bg-white">
          <h2 className="text-sm font-semibold text-zinc-800 truncate">{title}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors shrink-0 p-1">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Markdown content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <Markdown content={content} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskDetailModal — modal overlay with tabs for parallel workers + timeline
// ─────────────────────────────────────────────────────────────────────────────

export function TaskDetailModal({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const workers = getEntryWorkers(entry);
  const toolCallCount = (entry.toolEvents ?? []).filter(e => e.type === 'tool_use').length;
  const durationMs = entry.startedAt ? (entry.finishedAt ?? Date.now()) - entry.startedAt : undefined;
  const isMultiWorker = workers.length > 1;

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${isMultiWorker ? 'max-w-6xl' : 'max-w-3xl'} h-[calc(100vh-2rem)] flex flex-col overflow-hidden`}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="border-b border-zinc-100 px-5 py-4 flex items-start gap-3 shrink-0 sticky top-0 z-10 bg-white">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-800">{entry.label}</span>
              {entry.status === 'running' && <Spinner />}
              {entry.status === 'done' && <span className="text-emerald-500 text-xs">✓ Done</span>}
              {entry.status === 'error' && <span className="text-red-500 text-xs">✗ Error</span>}
            </div>
            <div className="flex items-center gap-3 mt-1">
              {durationMs != null && durationMs > 0 && <span className="text-[11px] text-zinc-400">⏱ {formatDurationShort(durationMs)}</span>}
              {toolCallCount > 0 && <span className="text-[11px] text-zinc-400">🔧 {toolCallCount} tool calls</span>}
              <span className="text-[11px] text-zinc-400">{(entry.toolEvents ?? []).length} events</span>
              {isMultiWorker && <span className="text-[11px] text-zinc-400">👥 {workers.length} workers</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors shrink-0 p-1">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <TaskDetailContent entry={entry} fullHeight />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers / small components
// ─────────────────────────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 disabled:opacity-40 transition-colors';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-500">{label}</label>
      {children}
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9 11L4 6l5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <rect x="1" y="1" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin text-zinc-400" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.2" />
      <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
