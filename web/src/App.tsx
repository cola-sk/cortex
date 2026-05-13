import { useState, useEffect } from 'react';
import { api } from './api';
import type { Agent } from './types';
import { AgentCard } from './components/AgentCard';
import { AgentModal } from './components/AgentModal';
import { ImportPanel } from './components/ImportPanel';

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
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

  const handleAdd = () => {
    setEditingAgent(null);
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
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="text-lg text-indigo-600">◈</span>
            <span className="text-sm font-semibold text-zinc-800">Cortex</span>
            <span className="hidden sm:inline text-xs text-zinc-400 ml-1">/ Agent Manager</span>
          </div>
          <button
            onClick={handleAdd}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
          >
            <PlusIcon />
            Add Agent
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-6xl px-5 py-8">
        {loading && (
          <div className="flex items-center justify-center py-24">
            <Spinner />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-600">
            <span className="font-medium">Failed to load agents:</span> {error}
            <button onClick={loadAgents} className="ml-3 underline hover:no-underline">
              Retry
            </button>
          </div>
        )}

        {!loading && !error && agents.length === 0 && (
          <>
            <ImportPanel onImported={loadAgents} />
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="text-4xl mb-4 opacity-20">◈</div>
              <h2 className="text-sm font-semibold text-zinc-600 mb-1">No agents configured</h2>
              <p className="text-xs text-zinc-400 mb-5">
                Add your first agent to get started.
              </p>
              <button
                onClick={handleAdd}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
              >
                Add Agent
              </button>
            </div>
          </>
        )}

        {!loading && !error && agents.length > 0 && (
          <>
            <ImportPanel onImported={loadAgents} />
            <div className="mb-5 flex items-center justify-between">
              <h1 className="text-xs font-medium text-zinc-400">
                {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
              </h1>
              <button
                onClick={loadAgents}
                className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors flex items-center gap-1"
              >
                <RefreshIcon /> Refresh
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {/* Modal */}
      {modalOpen && (
        <AgentModal
          agent={editingAgent}
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
