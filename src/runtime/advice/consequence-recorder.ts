'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStorePath, resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');

type ConsequenceOutcome =
  | 'consequence-confirmed'
  | 'disproven'
  | 'escalation-justified'
  | 'false-alarm';

interface AdvicePickEntry {
  schema: 1;
  type: 'pick';
  pickId: string;
  at: string;
  kind: string;
  caller: string;
  taskId: string | null;
  mode: 'off' | 'shadow' | 'act';
  static: string;
  pick: string;
  elevated: boolean;
  model: string | null;
  durationMs: number;
  stateDigest: string;
}

interface ConsequenceEntry {
  schema: 1;
  type: 'outcome';
  pickId: string;
  at: string;
  outcome: ConsequenceOutcome;
  source: string;
  details?: Record<string, any>;
}

function generatePickId(epoch: number = Date.now()): string {
  const hex = crypto.randomBytes(3).toString('hex');
  return `adv-${String(epoch).padStart(13, '0')}-${hex}`;
}

function resolveAdvicePicksDir(roots: any, fsImpl: any = fs): string | null {
  try {
    // 1. When roots is a direct project path string
    if (typeof roots === 'string' && roots.trim()) {
      return path.join(roots.trim(), '.doflow', 'state', 'advice', 'picks');
    }

    // 2. When roots has projectRoot (e.g. { projectRoot: root })
    if (roots && typeof roots.projectRoot === 'string' && roots.projectRoot.trim()) {
      return path.join(roots.projectRoot.trim(), '.doflow', 'state', 'advice', 'picks');
    }

    // 3. When roots has ['project-state']
    if (roots && typeof roots['project-state'] === 'string' && roots['project-state'].trim()) {
      return path.join(roots['project-state'].trim(), 'advice', 'picks');
    }

    // 4. When roots has ['user-state']
    if (roots && typeof roots['user-state'] === 'string' && roots['user-state'].trim()) {
      return path.join(roots['user-state'].trim(), 'advice', 'picks');
    }

    // 5. Fallback via storage registry and resolveRoots
    let targetRoots = roots;
    if (!targetRoots) {
      const reg = loadStorageRegistry({ fsImpl: fs });
      if (reg?.ok) {
        targetRoots = resolveRoots({ registry: reg.registry });
      }
    }
    if (targetRoots?.['project-state']) {
      return path.join(targetRoots['project-state'], 'advice', 'picks');
    }
    if (targetRoots?.['user-state']) {
      return path.join(targetRoots['user-state'], 'advice', 'picks');
    }
    return path.join(process.cwd(), '.doflow', 'state', 'advice', 'picks');
  } catch {
    return path.join(process.cwd(), '.doflow', 'state', 'advice', 'picks');
  }
}

function recordPick(
  entry: Omit<AdvicePickEntry, 'schema' | 'type' | 'pickId'> & { pickId?: string },
  options?: { roots?: any; fsImpl?: any }
): string | null {
  const fsImpl = options?.fsImpl || fs;
  try {
    const at = entry.at || new Date().toISOString();
    const epoch = Date.parse(at) || Date.now();
    const pickId = entry.pickId || generatePickId(epoch);

    const fullEntry: AdvicePickEntry = {
      schema: 1,
      type: 'pick',
      pickId,
      at,
      kind: entry.kind,
      caller: entry.caller,
      taskId: entry.taskId ?? null,
      mode: entry.mode,
      static: entry.static,
      pick: entry.pick,
      elevated: entry.elevated ?? false,
      model: entry.model ?? null,
      durationMs: entry.durationMs ?? 0,
      stateDigest: entry.stateDigest || '',
    };

    const dir = resolveAdvicePicksDir(options?.roots, fsImpl);
    if (!dir) return null;

    const partition = `${at.slice(0, 10)}.jsonl`;
    const targetFile = path.join(dir, partition);

    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.appendFileSync(targetFile, `${JSON.stringify(fullEntry)}\n`, 'utf8');

    return pickId;
  } catch {
    return null;
  }
}

function recordConsequence(
  entry: { pickId: string; outcome: ConsequenceOutcome; source: string; details?: any; at?: string },
  options?: { roots?: any; fsImpl?: any }
): boolean {
  const fsImpl = options?.fsImpl || fs;
  try {
    if (!entry.pickId || !entry.outcome) return false;
    const at = entry.at || new Date().toISOString();

    const fullEntry: ConsequenceEntry = {
      schema: 1,
      type: 'outcome',
      pickId: entry.pickId,
      at,
      outcome: entry.outcome,
      source: entry.source || 'runtime',
      details: entry.details,
    };

    const dir = resolveAdvicePicksDir(options?.roots, fsImpl);
    if (!dir) return false;

    const partition = `${at.slice(0, 10)}.jsonl`;
    const targetFile = path.join(dir, partition);

    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.appendFileSync(targetFile, `${JSON.stringify(fullEntry)}\n`, 'utf8');

    return true;
  } catch {
    return false;
  }
}

function pruneOldPartitions(dir: string, fsImpl: any = fs, maxAgeDays: number = 90): number {
  try {
    if (!fsImpl.existsSync(dir)) return 0;
    const entries = fsImpl.readdirSync(dir);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const name of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const datePart = name.slice(0, 10);
      const fileEpoch = Date.parse(`${datePart}T00:00:00.000Z`);
      if (Number.isFinite(fileEpoch) && now - fileEpoch > maxAgeMs) {
        fsImpl.unlinkSync(path.join(dir, name));
        pruned++;
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}

module.exports = {
  recordPick,
  recordConsequence,
  pruneOldPartitions,
  generatePickId,
};
