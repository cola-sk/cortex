export type ToolEventType = 'tool_use' | 'tool_result' | 'text';

export interface ToolEvent {
  index: number;
  type: ToolEventType;
  /** Tool name for tool_use events (e.g. "Bash", "Read", "Write", "WebSearch") */
  name?: string;
  /** Structured input for tool_use events */
  input?: Record<string, unknown>;
  /** Text content for text and tool_result events */
  content?: string;
  /** Links tool_result back to its tool_use */
  toolUseId?: string;
  /** True when a tool_result represents an error response */
  isError?: boolean;
}
