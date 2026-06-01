import type { Agent, Pipeline, RunEventType, RunSummary, RunRecord } from './types';

export interface DetectedTool {
  id: string;
  name: string;
  detected: boolean;
  provider?: unknown;
  model?: string;
  note?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    let message: string;
    try {
      const data = JSON.parse(text) as { error?: string };
      message = data.error ?? `HTTP ${res.status}`;
    } catch {
      // Non-JSON response (e.g. HTML 404 page) — strip tags and use first line
      message = text.replace(/<[^>]+>/g, '').trim().split('\n')[0] || `HTTP ${res.status}`;
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ---- Agents ----
  getAgents: () => request<Agent[]>('/api/agents'),

  fetchModels: (baseURL: string, apiKey?: string, providerType?: string, command?: string) =>
    request<{ models: string[] }>('/api/models/fetch', {
      method: 'POST',
      body: JSON.stringify({ baseURL, apiKey, providerType, command }),
    }),

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

  // ---- Importers ----
  getImporters: () => request<DetectedTool[]>('/api/importers'),

  importTool: (toolId: string, agentId?: string) =>
    request<Agent>(`/api/importers/${encodeURIComponent(toolId)}`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),

  // ---- Pipelines ----
  getPipelines: () => request<Pipeline[]>('/api/pipelines'),

  validateWorkspace: (wsPath: string) =>
    request<{ ok: boolean; resolved: string }>(`/api/workspace/validate?path=${encodeURIComponent(wsPath)}`),

  createPipeline: (pipeline: Omit<Pipeline, 'id'>) =>
    request<Pipeline>('/api/pipelines', {
      method: 'POST',
      body: JSON.stringify(pipeline),
    }),

  updatePipeline: (id: string, pipeline: Omit<Pipeline, 'id'>) =>
    request<Pipeline>(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(pipeline),
    }),

  deletePipeline: (id: string) =>
    request<{ success: boolean }>(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // ---- Runs ----
  getRuns: () => request<RunSummary[]>('/api/runs'),
  getRun: (id: string) => request<RunRecord>(`/api/runs/${encodeURIComponent(id)}`),
  deleteRun: (id: string) =>
    request<{ success: boolean }>(`/api/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** Submit a human review for a paused task */
  submitReview: (
    runId: string,
    taskId: string,
    action: 'approve' | 'revise',
    comment: string,
    targetTaskId?: string,
    agentId?: string,
  ) =>
    request<{ success: boolean }>(`/api/runs/${encodeURIComponent(runId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ taskId, action, comment, targetTaskId, agentId }),
    }),

  /** Retry a failed task from a historical run with comment context (optionally override current task agent). */
  continueRun: (runId: string, taskId: string, comment: string, agentId?: string) =>
    request<{ success: boolean; runId: string }>(`/api/runs/${encodeURIComponent(runId)}/continue`, {
      method: 'POST',
      body: JSON.stringify({ taskId, comment, agentId }),
    }),

  /** Branch a successful task from a historical run with optional comment and agent override. */
  branchRun: (runId: string, taskId: string, comment?: string, agentId?: string) =>
    request<{ success: boolean; runId: string }>(`/api/runs/${encodeURIComponent(runId)}/branch`, {
      method: 'POST',
      body: JSON.stringify({ taskId, comment, agentId }),
    }),


  /** Terminate a live pipeline run in real time */
  interruptTask: (runId: string, taskId: string) =>
    request<{ success: boolean }>(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/interrupt`, {
      method: 'POST',
    }),

  /** Run a pipeline via SSE. Calls onEvent for each event; resolves when stream ends. */
  async runPipeline(
    id: string,
    goal: string,
    onEvent: (type: RunEventType, data: unknown) => void,
  ): Promise<void> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    });

    if (!res.body) throw new Error('No response body from run endpoint');
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType: RunEventType = 'task:start';
          let dataStr = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7) as RunEventType;
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (dataStr) {
            try { onEvent(eventType, JSON.parse(dataStr)); } catch { /* ignore */ }
          }
        }
      }
      if (done) {
        break;
      }
    }
  },

  /**
   * Subscribe to a running run's SSE stream. Returns null if the run is not active.
   * The caller gets an abort function to stop listening.
   */
  subscribeRun(
    runId: string,
    onEvent: (type: RunEventType, data: unknown) => void,
  ): { abort: () => void } | null {
    const controller = new AbortController();
    let active = true;

    (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || res.status === 204 || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (active) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const part of parts) {
              if (!part.trim()) continue;
              let eventType: RunEventType = 'task:start';
              let dataStr = '';
              for (const line of part.split('\n')) {
                if (line.startsWith('event: ')) eventType = line.slice(7) as RunEventType;
                else if (line.startsWith('data: ')) dataStr = line.slice(6);
              }
              if (dataStr) {
                try { onEvent(eventType, JSON.parse(dataStr)); } catch { /* ignore */ }
              }
            }
          }
          if (done) break;
        }
      } catch {
        // aborted or network error — silent
      }
    })();

    return {
      abort: () => {
        active = false;
        controller.abort();
      },
    };
  },
};
