import type { Agent } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  getAgents: () => request<Agent[]>('/api/agents'),

  createAgent: (agent: Agent) =>
    request<Agent>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(agent),
    }),

  updateAgent: (id: string, agent: Omit<Agent, 'id'>) =>
    request<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(agent),
    }),

  deleteAgent: (id: string) =>
    request<{ success: boolean }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
