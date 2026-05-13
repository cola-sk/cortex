import { useState, useEffect, useRef, useCallback } from 'react';
import type { Agent, Pipeline, PipelineTask, PipelineDecision, RunEventType } from '../types';
import { api } from '../api';
import { useTranslation } from 'react-i18next';

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
    if (level.length === 0) break;
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
    const id = tpl.id + '_' + Date.now().toString(36);
    setEditing({ id, ...tpl.pipeline });
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
        await api.createPipeline(p);
        showToast(`Created "${p.name}"`);
      }
      await load();
      setView('list');
    } catch (e) { showToast((e as Error).message, false); }
  };

  const handleRun = (p: Pipeline) => { setRunning(p); setView('run'); };

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

  if (view === 'run' && running) {
    return (
      <RunView
        pipeline={running}
        onBack={() => { setView('list'); setRunning(null); }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-6xl px-5 py-8">
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
  const [isDirty, setIsDirty] = useState(!pipeline.id); // new pipelines are dirty
  const [saving, setSaving] = useState(false);
  const [idError, setIdError] = useState('');

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
    if (!draft.id.trim()) { setIdError(t('pipeline.idRequired')); return; }
    if (!/^[a-z0-9_-]+$/.test(draft.id)) { setIdError(t('pipeline.idFormat')); return; }
    setIdError('');
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };

  const levels = computeLevels(draft.tasks);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-white border-b border-zinc-200">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 hover:text-zinc-700 flex items-center gap-1.5 text-xs transition-colors shrink-0">
            <ChevronLeftIcon /> {t('common.back')}
          </button>
          <div className="w-px h-4 bg-zinc-200 shrink-0" />
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <input
                className="text-sm font-semibold text-zinc-800 bg-transparent outline-none border-b border-transparent hover:border-zinc-300 focus:border-indigo-400 transition-colors w-48 truncate"
                value={draft.name}
                {...{ placeholder: t('pipeline.namePlaceholder') }}
                onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
              />
              {idError && <span className="text-xs text-red-500">{idError}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400">{t('pipeline.idLabel')}</span>
              <input
                className="text-xs font-mono-custom bg-zinc-50 border border-zinc-200 rounded-md px-2 py-1 outline-none focus:border-indigo-400 w-36"
                value={draft.id}
                placeholder="my-pipeline"
                disabled={!!pipeline.id}
                onChange={(e) => { update((p) => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })); setIdError(''); }}
              />
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onRun(draft)}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
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
          <div className="max-w-3xl mx-auto">
            {/* Description row */}
            <div className="mb-6">
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
      <p className="text-xs font-semibold text-zinc-800 truncate">{task.name}</p>
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
  task, allTasks, agents, onChange, onDelete }: {
  task: PipelineTask;
  allTasks: PipelineTask[];
  agents: Agent[];
  onChange: (t: PipelineTask) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isMulti = Array.isArray(task.agent);
  const agentKeys: string[] = isMulti ? [...(task.agent as string[])] : [task.agent as string];

  const setField = <K extends keyof PipelineTask>(key: K, val: PipelineTask[K]) =>
    onChange({ ...task, [key]: val });

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
          {allTasks.filter((t) => t.id !== task.id).map((t) => (
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
          {allTasks.filter((t) => t.id !== task.id).length === 0 && (
            <p className="text-xs text-zinc-300">{t('step.noOtherSteps')}</p>
          )}
        </div>
      </Field>
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

interface LogEntry {
  id: string;
  type: RunEventType;
  label: string;
  detail?: string;
  status: 'running' | 'done' | 'error' | 'decision';
}

function RunView({
  pipeline, onBack }: { pipeline: Pipeline; onBack: () => void }) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<Record<string, { output: string; error?: string }>>({});
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
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
        if (type === 'task:start') {
          addEntry({
            id: d.taskId as string,
            type,
            label: `${d.taskName as string}`,
            detail: `Running via ${(d.agents as string[]).join(', ')}`,
            status: 'running',
          });
        } else if (type === 'task:complete') {
          updateEntry(d.taskId as string, {
            status: d.error ? 'error' : 'done',
            detail: d.error ? (d.error as string) : (d.output as string),
          });
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
          setDone(true);
        } else if (type === 'error') {
          setFatalError(d.message as string);
          setDone(true);
        }
      });
    } catch (e) {
      setFatalError((e as Error).message);
      setDone(true);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-white border-b border-zinc-200">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 hover:text-zinc-700 flex items-center gap-1.5 text-xs transition-colors shrink-0">
            <ChevronLeftIcon /> Back
          </button>
          <div className="w-px h-4 bg-zinc-200 shrink-0" />
          <span className="text-sm font-semibold text-zinc-800 truncate">{pipeline.name}</span>
          <span className="text-xs text-zinc-400">{t('run.label')}</span>
        </div>
      </div>

      <div className="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col gap-6">
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
            <div ref={logRef} className="divide-y divide-zinc-50 max-h-[60vh] overflow-y-auto">
              {log.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  isExpanded={expandedId === entry.id}
                  onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                />
              ))}
              {log.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-zinc-300">{t('run.starting')}</div>
              )}
            </div>
          </div>
        )}

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
                <div key={taskId}>
                  <button
                    onClick={() => setExpandedId(expandedId === `result_${taskId}` ? null : `result_${taskId}`)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.error ? 'bg-red-400' : 'bg-emerald-400'}`} />
                    <span className="flex-1 text-xs font-mono-custom text-zinc-700">{taskId}</span>
                    <ChevronRightIcon className={`w-3 h-3 text-zinc-300 transition-transform ${expandedId === `result_${taskId}` ? 'rotate-90' : ''}`} />
                  </button>
                  {expandedId === `result_${taskId}` && (
                    <div className="px-4 pb-4">
                      <pre className="text-xs text-zinc-600 whitespace-pre-wrap bg-zinc-50 rounded-lg p-3 max-h-64 overflow-y-auto leading-relaxed">
                        {r.error ? `ERROR: ${r.error}` : r.output}
                      </pre>
                    </div>
                  )}
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
    </div>
  );
}

function LogRow({ entry, isExpanded, onToggle }: {
  entry: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const icons: Record<LogEntry['status'], string> = {
    running: '◌',
    done: '✓',
    error: '✗',
    decision: '⬡',
  };
  const colors: Record<LogEntry['status'], string> = {
    running: 'text-zinc-400',
    done: 'text-emerald-500',
    error: 'text-red-500',
    decision: 'text-amber-500',
  };

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
      >
        <span className={`shrink-0 mt-0.5 text-sm ${colors[entry.status]} ${entry.status === 'running' ? 'animate-pulse' : ''}`}>
          {icons[entry.status]}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-zinc-700">{entry.label}</p>
          {entry.detail && !isExpanded && (
            <p className="text-xs text-zinc-400 truncate mt-0.5">{entry.detail}</p>
          )}
        </div>
        {entry.detail && (
          <ChevronRightIcon className={`shrink-0 w-3 h-3 text-zinc-300 transition-transform mt-0.5 ${isExpanded ? 'rotate-90' : ''}`} />
        )}
      </button>
      {isExpanded && entry.detail && (
        <div className="px-10 pb-3">
          <pre className="text-xs text-zinc-600 whitespace-pre-wrap bg-zinc-50 rounded-lg p-3 max-h-48 overflow-y-auto leading-relaxed">
            {entry.detail}
          </pre>
        </div>
      )}
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
