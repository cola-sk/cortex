import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import type { Agent } from './types';
import { AgentCard } from './components/AgentCard';
import { AgentModal } from './components/AgentModal';
import { ImportPanel } from './components/ImportPanel';
import type { AgentRole } from './types';
import { PipelinePage } from './components/PipelinePage';
import { RunsPage } from './components/RunsPage';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';

type Page = 'models' | 'roles' | 'pipelines' | 'runs';
const VALID_PAGES = ['models', 'roles', 'pipelines', 'runs'] as const;

function readPageFromHash(): Page {
  const hash = window.location.hash.replace('#', '');
  if (VALID_PAGES.includes(hash as Page)) return hash as Page;
  return 'models';
}

export default function App() {
  const { t } = useTranslation();
  const [page, setPageState] = useState<Page>(readPageFromHash);

  const setPage = useCallback((p: Page) => {
    window.location.hash = '#' + p;
    setPageState(p);
  }, []);

  useEffect(() => {
    const handler = () => setPageState(readPageFromHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [addKind, setAddKind] = useState<'model' | 'role'>('model');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAgents = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAgents();
      setAgents(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const handleAdd = (kind: 'model' | 'role' = 'model') => {
    setEditingAgent(null);
    setAddKind(kind);
    setModalOpen(true);
  };

  const handleEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete agent "${id}"? This cannot be undone.`)) return;
    try {
      await api.deleteAgent(id);
      showToast(`Agent "${id}" deleted`);
      loadAgents();
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  };

  const handleSave = async (agentData: Agent) => {
    const { id, ...rest } = agentData;
    if (editingAgent) {
      await api.updateAgent(editingAgent.id, rest);
      showToast(`Agent "${editingAgent.id}" updated`);
    } else {
      await api.createAgent(agentData);
      showToast(`Agent "${id}" created`);
    }
    setModalOpen(false);
    loadAgents();
  };

  return (
    <div className="min-h-screen bg-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              <span className="text-lg text-indigo-600">◈</span>
              <span className="text-sm font-semibold text-zinc-800">Cortex</span>
            </div>
            {/* Tab nav */}
            <nav className="flex items-center gap-1 rounded-lg bg-zinc-100 p-0.5">
              {(['models', 'roles', 'pipelines', 'runs'] as Page[]).map((p) => (
                <button key={p} onClick={() => setPage(p)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    page === p ? 'bg-white text-zinc-800 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                  }`}>
                  {t(`app.${p}`)}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
             <button
              className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-800 bg-zinc-100 rounded"
              onClick={() => i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}
            >
              {i18n.language.startsWith('zh') ? '中文' : 'English'}
            </button>
            {page === 'models' && (
              <button onClick={() => handleAdd('model')}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:border-zinc-400 transition-colors">
                <PlusIcon />{t('agent.addModelTitle')}
              </button>
            )}
            {page === 'roles' && (
              <button onClick={() => handleAdd('role')}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors">
                <PlusIcon />{t('agent.addRoleTitle')}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Pipeline page */}
      {page === 'pipelines' && (
        <PipelinePage agents={agents.filter((a) => !!a.role)} />
      )}

      {/* Runs page */}
      {page === 'runs' && <RunsPage />}

      {/* Models page */}
      {page === 'models' && (
        <AgentPage
          loading={loading} error={error}
          agents={agents.filter((a) => !a.role)}
          emptyTitle={t('app.noModels', 'No model connections')}
          emptyDesc={t('app.noModelsDesc', 'Add a model connection to get started.')}
          onAdd={() => handleAdd('model')}
          onEdit={handleEdit} onDelete={handleDelete} onRefresh={loadAgents}
          header={<ImportPanel agents={agents} onImported={loadAgents} />}
        />
      )}

      {/* Roles page */}
      {page === 'roles' && (
        <AgentPage
          loading={loading} error={error}
          agents={agents.filter((a) => !!a.role)}
          allAgents={agents}
          emptyTitle={t('app.noRoles', 'No role agents')}
          emptyDesc={t('app.noRolesDesc', 'Add a role agent and assign it a model connection.')}
          onAdd={() => handleAdd('role')}
          onEdit={handleEdit} onDelete={handleDelete} onRefresh={loadAgents}
        />
      )}

      {/* Modal */}
      {modalOpen && (
        <AgentModal
          agent={editingAgent}
          agents={agents}
          defaultKind={addKind}
          onSave={handleSave}
          onClose={() => setModalOpen(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-xl transition-all ${
            toast.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-600 shadow-red-100'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 shadow-emerald-100'
          }`}
        >
          {toast.type === 'success' ? '✓ ' : '✗ '}{toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Detect if an agent was imported (description set by importer) ─────────
const IMPORTED_TOOLS = new Set(['claude-code', 'codex', 'gemini', 'hermes']);
function isImported(agent: { id: string; description?: string }) {
  return IMPORTED_TOOLS.has(agent.id) || agent.description?.startsWith('Imported from');
}

const ROLE_ORDER: Array<AgentRole | undefined> = ['orchestrator', 'worker', 'reviewer', 'decider', undefined];

function AgentPage({
  loading, error, agents, emptyTitle, emptyDesc,
  onAdd, onEdit, onDelete, onRefresh, header, allAgents,
}: {
  loading: boolean;
  error: string | null;
  agents: import('./types').Agent[];
  emptyTitle: string;
  emptyDesc: string;
  onAdd: () => void;
  onEdit: (a: import('./types').Agent) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  header?: React.ReactNode;
  allAgents?: import('./types').Agent[];
}) {
  const { t } = useTranslation();
  const lookupAgents = allAgents ?? agents;
  const modelLabelFor = (agent: import('./types').Agent): string | undefined => {
    if (agent.provider) {
      if (agent.provider.type === 'cli') return agent.provider.command;
      if (agent.provider.type === 'claude') return agent.provider.model ?? 'default';
      return agent.provider.model;
    }
    if (!agent.baseAgent) return undefined;
    const base = lookupAgents.find((a) => a.id === agent.baseAgent);
    if (!base) return agent.baseAgent;
    return base.name ? `${base.name} (#${base.id})` : base.id;
  };

  const sorted = [...agents].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  return (
    <main className="mx-auto px-5 py-8">
      {loading && <div className="flex items-center justify-center py-24"><Spinner /></div>}
      {!loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-600">
          <span className="font-medium">Failed to load agents:</span> {error}
          <button onClick={onRefresh} className="ml-3 underline hover:no-underline">Retry</button>
        </div>
      )}
      {!loading && !error && (
        <>
          {header}
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="text-4xl mb-4 opacity-20">◈</div>
              <h2 className="text-sm font-semibold text-zinc-600 mb-1">{emptyTitle}</h2>
              <p className="text-xs text-zinc-400 mb-5">{emptyDesc}</p>
              <button onClick={onAdd} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors">
                {emptyTitle}
              </button>
            </div>
          ) : (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs text-zinc-400">
                  {sorted.length} {sorted.length !== 1 ? t('app.agentsCount', 'items') : t('app.agentCount', 'item')}
                </span>
                <button onClick={onRefresh} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors flex items-center gap-1">
                  <RefreshIcon /> {t('common.refresh', 'Refresh')}
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {sorted.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    modelLabel={modelLabelFor(a)}
                    imported={isImported(a)}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 5.5A4 4 0 1 1 5.5 1.5M9.5 1.5v4h-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin text-zinc-400" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
      <path d="M18 10a8 8 0 0 0-8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
