import type { ProviderConfig } from '../config/schema.js';

export interface DetectedTool {
  /** Unique key, used as agent id prefix */
  id: string;
  /** Display name */
  name: string;
  /** Whether the config file was found */
  detected: boolean;
  /** Extracted provider config, undefined if not detected or incomplete */
  provider?: ProviderConfig;
  /** Model extracted from config */
  model?: string;
  /** Short note about what was detected */
  note?: string;
}
