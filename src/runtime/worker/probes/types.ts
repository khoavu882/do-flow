'use strict';

import type { SyncHarnessResult } from '../../models/types.ts';

export interface ProbeOptions {
  timeoutMs?: number;
  execFileImpl?: any;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
  homeDir?: string;
  projectRoot?: string;
}

export type HarnessProbeRunner = (options?: ProbeOptions) => Promise<SyncHarnessResult>;
