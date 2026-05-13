import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, AgentRole, ProviderType } from '../types';
import { useTranslation } from 'react-i18next';

interface Props {
  agent: Agent | null;
  agents: Agent[];
  defaultKind?: AgentKind;
  onSave: (agent: Agent) => Promise<void>;
  onClose: () => void;
}

type AgentKind = 'model' | 'role';

interface ModelForm { id: string; name: string; description: string; providerType: ProviderType; model: string; baseURL: string; apiKey: string; }
interface RoleForm  { id: string; name: string; role: AgentRole | ''; description: string; system: string; baseAgent: string; }

const DEFAULT_MODEL_FORM: ModelForm = { id: '', name: '', description: '', providerType: 'claude', model: '', baseURL: '', apiKey: '' };
const DEFAULT_ROLE_FORM:  RoleForm  = { id: '', name: '', role: '', description: '', system: '', baseAgent: '' };

const ROLE_TEMPLATES: Record<string, string> = {
  orchestrator: `You are a technical planning expert. Given a goal and available agents, decompose it into an optimised execution plan.

Respond with a single valid JSON object (no markdown fences):
{
  "goal": "<goal>",
  "tasks": [
    {
      "id": "task_1",
      "name": "<short name>",
      "agent": "<agent key> OR [\\"agent_a\\",\\"agent_b\\"] for parallel workers",
      "input": "<self-contained instruction>",
      "dependsOn": []
    }
  ],
  "decisions": [
    {
      "id": "decide_1",
      "name": "<checkpoint name>",
      "agent": "<decider agent key>",
      "evaluates": ["task_id"],
      "maxRetries": 2
    }
  ]
}

Rules:
- Tasks without dependsOn run IN PARALLEL automatically
- Use dependsOn[] for sequential dependencies
- agent as array runs multiple workers simultaneously on the same input
- decisions[] adds quality checkpoints — the decider can retry tasks
- Do NOT include tasks for yourself`,
  worker: `You are a specialized worker agent. You receive a task and produce clean, well-structured output.
Include brief inline comments where helpful. Output directly without unnecessary preamble.`,
  reviewer: `You are an expert reviewer. Given outputs, identify bugs, logical flaws, and improvements.
Be concise. Use bullet points. Separate issues by severity: Critical / Warning / Suggestion.`,
  decider: `You are a quality-control evaluator. Review task outputs and decide if they are satisfactory.

Analyse the provided results against the stated goal. Respond with ONLY valid JSON (no markdown fences):
{
  "action": "continue" | "retry",
  "retryTaskIds": ["task_id"],
  "reason": "<one-sentence explanation>"
}

Use "retry" only when there is a clear, fixable quality issue.
Always include retryTaskIds when action is "retry".
Default to "continue" when in doubt.`
};

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function agentToKind(agent: Agent): AgentKind { return agent.role ? 'role' : 'model'; }

function agentToModelForm(a: Agent): ModelForm {
  const p = a.provider;
  return { id: a.id, name: a.name ?? '', description: a.description ?? '', providerType: p?.type ?? 'claude',
    model: p?.type === 'cli' ? p.command : (p as {model?:string})?.model ?? '',
    baseURL: p?.type !== 'cli' ? (p as {baseURL?:string})?.baseURL ?? '' : '',
    apiKey:  p?.type !== 'cli' ? (p as {apiKey?:string})?.apiKey  ?? '' : '' };
}

function agentToRoleForm(a: Agent): RoleForm {
  return { id: a.id, name: a.name ?? '', role: a.role ?? '', description: a.description ?? '', system: a.system, baseAgent: a.baseAgent ?? '' };
}

function modelFormToAgent(f: ModelForm): Agent {
  const id = f.id.trim();
  const base = { id, name: f.name.trim() || id, description: f.description.trim() || undefined, system: '' };
  if (f.providerType === 'claude')       return { ...base, provider: { type: 'claude',       ...(f.model   ? { model:   f.model.trim()   } : {}), ...(f.baseURL ? { baseURL: f.baseURL.trim() } : {}), ...(f.apiKey  ? { apiKey:  f.apiKey.trim()  } : {}) } };
  if (f.providerType === 'cli')          return { ...base, provider: { type: 'cli', command: f.model.trim() || 'claude', args: [] } };
  return { ...base, provider: { type: 'openai-compat', baseURL: f.baseURL.trim(), model: f.model.trim(), ...(f.apiKey ? { apiKey: f.apiKey.trim() } : {}) } };
}

function roleFormToAgent(f: RoleForm): Agent {
  const id = f.id.trim();
  return {
    id,
    name: f.name.trim() || id,
    role: f.role as AgentRole,
    description: f.description.trim() || undefined,
    system: f.system.trim(),
    baseAgent: f.baseAgent.trim(),
  };
}

const selectCls   = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 transition-colors cursor-pointer';
const textareaCls = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize-y transition-colors';

export function AgentModal({ agent, agents, defaultKind = 'model', onSave, onClose }: Props) {
  const { t } = useTranslation();
  const isEdit = agent !== null;
  const [kind,      setKind]      = useState<AgentKind>(isEdit ? agentToKind(agent) : defaultKind);
  const [modelForm, setModelForm] = useState<ModelForm>(() =>
    isEdit && agentToKind(agent) === 'model' ? agentToModelForm(agent) : { ...DEFAULT_MODEL_FORM, id: generateId() }
  );
  const [roleForm,  setRoleForm]  = useState<RoleForm>(() =>
    isEdit && agentToKind(agent) === 'role'  ? agentToRoleForm(agent)  : { ...DEFAULT_ROLE_FORM,  id: generateId() }
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Auto-focus name field when modal opens
  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 50); }, []);

  const modelAgents = agents.filter((a) => !a.role);

  const handleKeyDown = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }, [onClose]);
  useEffect(() => { document.addEventListener('keydown', handleKeyDown); return () => document.removeEventListener('keydown', handleKeyDown); }, [handleKeyDown]);

  const setM = (k: keyof ModelForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setModelForm((f) => ({ ...f, [k]: e.target.value }));
  const setR = (k: keyof RoleForm)  => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setRoleForm((f) => ({ ...f, [k]: e.target.value }));

  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newRole = e.target.value as AgentRole | '';
    setRoleForm((f) => {
      let nextSystem = f.system;
      const isCurrentEmptyOrTemplate = !f.system.trim() || Object.values(ROLE_TEMPLATES).includes(f.system);
      
      if (newRole && ROLE_TEMPLATES[newRole] && isCurrentEmptyOrTemplate) {
        nextSystem = ROLE_TEMPLATES[newRole];
      }
      
      return { ...f, role: newRole, system: nextSystem };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (kind === 'model') {
      if (!modelForm.id.trim()) { setError('ID is required'); return; }
      if (modelForm.providerType === 'openai-compat') {
        if (!modelForm.baseURL.trim()) { setError(t('agent.errBaseURLRequired')); return; }
        if (!modelForm.model.trim())   { setError(t('agent.errModelRequired'));   return; }
      }
    } else {
      if (!roleForm.id.trim())     { setError('ID is required'); return; }
      if (!roleForm.role)           { setError(t('agent.errRoleRequired')); return; }
      if (!roleForm.system.trim())  { setError(t('agent.errSystemRequired')); return; }
      if (!roleForm.baseAgent.trim()) { setError(t('agent.errBaseAgentRequired')); return; }
    }
    setSaving(true);
    try { await onSave(kind === 'model' ? modelFormToAgent(modelForm) : roleFormToAgent(roleForm)); }
    catch (err) { setError((err as Error).message); setSaving(false); }
  };

  const titleKey = isEdit
    ? (kind === 'model' ? 'agent.editModelTitle' : 'agent.editRoleTitle')
    : (kind === 'model' ? 'agent.addModelTitle'  : 'agent.addRoleTitle');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-200/80">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-800">{t(titleKey, { id: agent?.id })}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"><XIcon /></button>
        </div>

        {/* Kind toggle — removed; kind is set by the calling page */}

        <form onSubmit={handleSubmit} className="overflow-y-auto max-h-[68vh]">
          <div className="space-y-4 p-5">

            {/* ── MODEL CONNECTION ── */}
            {kind === 'model' && (
              <>
                <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700">{t('agent.modelKindDesc')}</div>
                <Field label={t('agent.fieldName')}>
                  <Input ref={nameRef} placeholder={t('agent.namePlaceholder')} value={modelForm.name} onChange={setM('name')} />
                </Field>
                <Field label={t('agent.fieldDescription')}>
                  <Input placeholder={t('agent.descPlaceholder')} value={modelForm.description} onChange={setM('description')} />
                </Field>
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <span>{t('agent.fieldId')}:</span>
                  <code className="font-mono bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-500">{modelForm.id}</code>
                </div>
                <Divider label={t('agent.sectionProvider')} />
                <Field label={t('agent.fieldProviderType')}>
                  <select value={modelForm.providerType} onChange={setM('providerType') as React.ChangeEventHandler<HTMLSelectElement>} className={selectCls}>
                    <option value="claude">{t('agent.providerClaude')}</option>
                    <option value="openai-compat">{t('agent.providerOpenAI')}</option>
                    <option value="cli" disabled>{t('agent.providerCli')}</option>
                  </select>
                </Field>
                <Field label={t('agent.fieldModel')} hint={modelForm.providerType === 'claude' ? t('agent.modelHintClaude') : t('agent.modelHintRequired')} required={modelForm.providerType === 'openai-compat'}>
                  <Input placeholder={modelForm.providerType === 'claude' ? t('agent.modelPlaceholderClaude') : t('agent.modelPlaceholderOpenAI')} value={modelForm.model} onChange={setM('model')} mono required={modelForm.providerType === 'openai-compat'} />
                </Field>
                <Field label={t('agent.fieldBaseURL')} hint={modelForm.providerType === 'claude' ? t('agent.baseURLHintClaude') : t('agent.baseURLHintOpenAI')} required={modelForm.providerType === 'openai-compat'}>
                  <Input placeholder={modelForm.providerType === 'claude' ? t('agent.baseURLPlaceholderClaude') : t('agent.baseURLPlaceholderOpenAI')} value={modelForm.baseURL} onChange={setM('baseURL')} type="url" required={modelForm.providerType === 'openai-compat'} />
                </Field>
                <Field label={t('agent.fieldApiKey')} hint={t('agent.apiKeyHint')}>
                  <Input placeholder={isEdit ? t('agent.apiKeyPlaceholderEdit') : t('agent.apiKeyPlaceholderNew')} value={modelForm.apiKey} onChange={setM('apiKey')} type="password" autoComplete="off" />
                </Field>
              </>
            )}

            {/* ── ROLE AGENT ── */}
            {kind === 'role' && (
              <>
                <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-700">{t('agent.roleKindDesc')}</div>
                <Field label={t('agent.fieldName')}>
                  <Input ref={nameRef} placeholder={t('agent.namePlaceholder')} value={roleForm.name} onChange={setR('name')} />
                </Field>
                <Field label={t('agent.fieldRole')} hint={t('agent.roleHint')} required>
                  <select value={roleForm.role} onChange={handleRoleChange} className={selectCls} required>
                    <option value="">{t('agent.roleNone')}</option>
                    <option value="orchestrator">{t('agent.roleOrchestrator')}</option>
                    <option value="worker">{t('agent.roleWorker')}</option>
                    <option value="reviewer">{t('agent.roleReviewer')}</option>
                    <option value="decider">{t('agent.roleDecider')}</option>
                  </select>
                </Field>
                <Field label={t('agent.fieldDescription')}>
                  <Input placeholder={t('agent.descPlaceholder')} value={roleForm.description} onChange={setR('description')} />
                </Field>
                <Field label={t('agent.fieldSystem')} required>
                  <textarea value={roleForm.system} onChange={setR('system')} placeholder={t('agent.systemPlaceholder')} rows={4} required className={textareaCls} />
                </Field>
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <span>{t('agent.fieldId')}:</span>
                  <code className="font-mono bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-500">{roleForm.id}</code>
                </div>

                <Divider label={t('agent.sectionModel')} />

                <Field label={t('agent.fieldBaseAgent')} hint={t('agent.baseAgentHint')} required>
                  <select value={roleForm.baseAgent} onChange={setR('baseAgent')} className={selectCls} required>
                    <option value="">{t('agent.baseAgentNone')}</option>
                    {modelAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name || a.id}{a.description ? ` — ${a.description}` : ''}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-4">
            {error ? <p className="text-xs text-red-500">{error}</p> : <span />}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {saving ? t('agent.btnSaving') : isEdit ? t('agent.btnSaveChanges') : (kind === 'model' ? t('agent.btnAddModel') : t('agent.btnAddRole'))}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-xs font-medium text-zinc-500">
        {label}{required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

function Input({ mono, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; ref?: React.Ref<HTMLInputElement> }) {
  return <input {...props} className={`w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${mono ? 'font-mono-custom' : ''}`} />;
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-zinc-100" />
      <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</span>
      <div className="h-px flex-1 bg-zinc-100" />
    </div>
  );
}

function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}
