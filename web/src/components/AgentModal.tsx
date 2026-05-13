import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentRole, ProviderType } from '../types';

interface Props {
  agent: Agent | null; // null = add mode
  onSave: (agent: Agent) => Promise<void>;
  onClose: () => void;
}

interface FormState {
  id: string;
  role: AgentRole | '';
  description: string;
  system: string;
  providerType: ProviderType;
  model: string;
  baseURL: string;
  apiKey: string;
}

const DEFAULT_FORM: FormState = {
  id: '',
  role: '',
  description: '',
  system: '',
  providerType: 'claude',
  model: '',
  baseURL: '',
  apiKey: '',
};

function agentToForm(agent: Agent): FormState {
  return {
    id: agent.id,
    role: agent.role ?? '',
    description: agent.description ?? '',
    system: agent.system,
    providerType: agent.provider.type,
    model: agent.provider.type === 'cli' ? agent.provider.command : (agent.provider.model ?? ''),
    baseURL: agent.provider.type !== 'cli' ? (agent.provider.baseURL ?? '') : '',
    apiKey: agent.provider.type !== 'cli' ? (agent.provider.apiKey ?? '') : '',
  };
}

function formToAgent(form: FormState): Agent {
  const base = {
    id: form.id.trim(),
    ...(form.role ? { role: form.role as AgentRole } : {}),
    description: form.description.trim() || undefined,
    system: form.system.trim(),
  };
  if (form.providerType === 'claude') {
    return {
      ...base,
      provider: {
        type: 'claude',
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.baseURL.trim() ? { baseURL: form.baseURL.trim() } : {}),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      },
    };
  }
  if (form.providerType === 'cli') {
    // CLI agents are imported; command is stored in model field
    return {
      ...base,
      provider: { type: 'cli', command: form.model.trim() || 'claude', args: [] },
    };
  }
  return {
    ...base,
    provider: {
      type: 'openai-compat',
      baseURL: form.baseURL.trim(),
      model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    },
  };
}

export function AgentModal({ agent, onSave, onClose }: Props) {
  const isEdit = agent !== null;
  const [form, setForm] = useState<FormState>(isEdit ? agentToForm(agent) : DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.system.trim()) {
      setError('System prompt is required');
      return;
    }
    if (form.providerType === 'openai-compat') {
      if (!form.baseURL.trim()) { setError('Base URL is required for OpenAI-compat provider'); return; }
      if (!form.model.trim()) { setError('Model is required for OpenAI-compat provider'); return; }
    }

    setSaving(true);
    try {
      await onSave(formToAgent(form));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-200/80">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-800">
            {isEdit ? `Edit Agent · ${agent.id}` : 'Add Agent'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
          >
            <XIcon />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="overflow-y-auto max-h-[75vh]">
          <div className="space-y-4 p-5">
            {/* ID */}
            <Field label="Agent ID" required>
              <Input
                placeholder="e.g. orchestrator"
                value={form.id}
                onChange={set('id')}
                mono
                disabled={isEdit}
                pattern="^[a-z0-9_-]+$"
                title="Lowercase letters, numbers, dash or underscore"
                required
              />
            </Field>

            {/* Role */}
            <Field label="Role" hint="Helps the orchestrator assign tasks appropriately">
              <select
                value={form.role}
                onChange={set('role')}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 transition-colors cursor-pointer"
              >
                <option value="">— None —</option>
                <option value="orchestrator">Orchestrator — plans and assigns tasks</option>
                <option value="worker">Worker — executes assigned tasks</option>
                <option value="reviewer">Reviewer — checks quality and correctness</option>
                <option value="decider">Decider — evaluates results and decides retry/continue</option>
              </select>
            </Field>

            {/* Description */}
            <Field label="Description">
              <Input
                placeholder="Short description (optional)"
                value={form.description}
                onChange={set('description')}
              />
            </Field>

            {/* System Prompt */}
            <Field label="System Prompt" required>
              <textarea
                value={form.system}
                onChange={set('system')}
                placeholder="You are a..."
                rows={4}
                required
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 resize-y transition-colors"
              />
            </Field>

            <Divider label="Provider" />

            {/* Provider Type */}
            <Field label="Provider Type">
              <select
                value={form.providerType}
                onChange={set('providerType') as React.ChangeEventHandler<HTMLSelectElement>}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 transition-colors cursor-pointer"
              >
                <option value="claude">Claude (Anthropic SDK)</option>
                <option value="openai-compat">OpenAI Compatible (HTTP)</option>
                <option value="cli" disabled>CLI (set by importer)</option>
              </select>
            </Field>

            {/* Model */}
            <Field
              label="Model"
              hint={form.providerType === 'claude' ? 'e.g. claude-opus-4-5 (leave blank for default)' : 'Required'}
              required={form.providerType === 'openai-compat'}
            >
              <Input
                placeholder={form.providerType === 'claude' ? 'claude-sonnet-4-5' : 'deepseek-chat'}
                value={form.model}
                onChange={set('model')}
                mono
                required={form.providerType === 'openai-compat'}
              />
            </Field>

            {/* Base URL */}
            <Field
              label="Base URL"
              hint={form.providerType === 'claude' ? 'Optional — override Anthropic API endpoint' : 'Required — OpenAI-compatible endpoint'}
              required={form.providerType === 'openai-compat'}
            >
              <Input
                placeholder={
                  form.providerType === 'claude'
                    ? 'https://api.anthropic.com (optional)'
                    : 'http://localhost:11434/v1'
                }
                value={form.baseURL}
                onChange={set('baseURL')}
                type="url"
                required={form.providerType === 'openai-compat'}
              />
            </Field>

            {/* API Key */}
            <Field label="API Key" hint="Stored in agents.yaml">
              <Input
                placeholder={isEdit ? '(leave blank to keep existing)' : 'sk-ant-… or ANTHROPIC_API_KEY env'}
                value={form.apiKey}
                onChange={set('apiKey')}
                type="password"
                autoComplete="off"
              />
            </Field>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-4">
            {error ? (
              <p className="text-xs text-red-500">{error}</p>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Agent'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- small helpers ----

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-xs font-medium text-zinc-500">
        {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

function Input({
  mono,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${mono ? 'font-mono-custom' : ''}`}
    />
  );
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
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
