'use strict';

const path = require('node:path');
const fs = require('node:fs');
import type { AgentRole, TaskOutcome } from './envelope.ts';

export interface ActiveClaim {
  taskId: string;
  runKey: string;
  attempt: number;
  agentRole: AgentRole;
  workerIdentity: string;
  writeSet: string[];
  claimedAt: string;
}

export interface TaskClaimRequest {
  taskId: string;
  runKey: string;
  agentRole: AgentRole;
  workerIdentity: string;
  writeSet: string[];
  projectRoot?: string;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason?:
    | 'ADMITTED'
    | 'WRITE_SET_CONFLICT'
    | 'WRITER_CAP_EXCEEDED'
    | 'MAX_ATTEMPTS_EXCEEDED';
  conflicts?: {
    conflictingTaskId: string;
    overlappingFiles: string[];
  };
  attemptIndex?: number;
}

export interface TaskReleaseRequest {
  taskId: string;
  runKey: string;
  outcome: TaskOutcome;
  modifiedFiles: string[];
  projectRoot?: string;
}

export interface AdmissionControllerOptions {
  projectRoot?: string;
  writerCap?: number;
  maxAttempts?: number;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
}

class AdmissionError extends Error {
  readonly code: 'ERR_WRITE_SET_CONFLICT' | 'ERR_WRITER_CAP_EXCEEDED' | 'ERR_MAX_ATTEMPTS_EXCEEDED';
  constructor(code: 'ERR_WRITE_SET_CONFLICT' | 'ERR_WRITER_CAP_EXCEEDED' | 'ERR_MAX_ATTEMPTS_EXCEEDED', message: string) {
    super(message);
    this.name = 'AdmissionError';
    this.code = code;
  }
}

function normalizePath(p: string): string {
  if (typeof p !== 'string') return '';
  return path.normalize(p).replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

function resolveTeamSettings(options?: AdmissionControllerOptions): { writerCap: number; maxAttempts: number } {
  let writerCap = 2;
  let maxAttempts = 3;

  // 1. Project settings files (.doflow/settings.json then .doflow/settings.local.json)
  const fsImpl = options?.fsImpl || fs;
  const projectRoot = options?.projectRoot;
  if (projectRoot) {
    const candidateFiles = [
      path.join(projectRoot, '.doflow', 'settings.json'),
      path.join(projectRoot, '.doflow', 'settings.local.json'),
    ];
    for (const file of candidateFiles) {
      try {
        if (fsImpl.existsSync(file)) {
          const raw = fsImpl.readFileSync(file, 'utf8');
          const data = JSON.parse(raw);
          if (typeof data['team.writerCap'] === 'number') {
            const v = data['team.writerCap'];
            if (v >= 1 && v <= 8) writerCap = v;
          }
          if (typeof data['team.maxAttempts'] === 'number') {
            const v = data['team.maxAttempts'];
            if (v >= 1 && v <= 10) maxAttempts = v;
          }
        }
      } catch {
        // ignore unreadable settings files
      }
    }
  }

  // 2. Environment variables override settings files
  const env = options?.env ?? process.env;
  if (env?.DOFLOW_TEAM_WRITER_CAP) {
    const parsed = parseInt(env.DOFLOW_TEAM_WRITER_CAP, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 8) {
      writerCap = parsed;
    }
  }

  if (env?.DOFLOW_TEAM_MAX_ATTEMPTS) {
    const parsed = parseInt(env.DOFLOW_TEAM_MAX_ATTEMPTS, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
      maxAttempts = parsed;
    }
  }

  // 3. Programmatic options override environment and files
  if (typeof options?.writerCap === 'number') {
    writerCap = options.writerCap;
  }
  if (typeof options?.maxAttempts === 'number') {
    maxAttempts = options.maxAttempts;
  }

  return { writerCap, maxAttempts };
}

class AdmissionController {
  private activeClaims: Map<string, ActiveClaim> = new Map();
  private taskAttempts: Map<string, number> = new Map();
  public readonly writerCap: number;
  public readonly maxAttempts: number;
  private readonly projectRoot?: string;
  private readonly fsImpl: any;

  constructor(options?: AdmissionControllerOptions) {
    this.projectRoot = options?.projectRoot;
    this.fsImpl = options?.fsImpl || fs;
    const settings = resolveTeamSettings(options);
    this.writerCap = settings.writerCap;
    this.maxAttempts = settings.maxAttempts;
  }

  /**
   * Evaluates if a proposed write set conflicts with any active claims without making a claim.
   */
  checkWriteSetCollision(writeSet: string[]): {
    conflict: boolean;
    conflictingTaskId?: string;
    overlappingFiles?: string[];
  } {
    const normalizedInput = writeSet.map(normalizePath).filter(Boolean);
    if (normalizedInput.length === 0) {
      return { conflict: false };
    }

    const inputSet = new Set(normalizedInput);

    for (const claim of this.activeClaims.values()) {
      const claimFiles = (claim.writeSet || []).map(normalizePath).filter(Boolean);
      const overlapping: string[] = [];
      for (const file of claimFiles) {
        if (inputSet.has(file)) {
          overlapping.push(file);
        }
      }
      if (overlapping.length > 0) {
        return {
          conflict: true,
          conflictingTaskId: claim.taskId,
          overlappingFiles: overlapping,
        };
      }
    }

    return { conflict: false };
  }

  /**
   * Attempts to claim a task for execution.
   */
  claimTask(request: TaskClaimRequest): AdmissionDecision {
    if (!request || !request.taskId) {
      throw new TypeError('claimTask: request must contain a valid taskId');
    }

    const currentAttempts = this.taskAttempts.get(request.taskId) || 0;
    const nextAttempt = currentAttempts + 1;

    // 1. Enforce attempt bound (IC-002 / IC-004)
    if (nextAttempt > this.maxAttempts) {
      return {
        admitted: false,
        reason: 'MAX_ATTEMPTS_EXCEEDED',
        attemptIndex: nextAttempt,
      };
    }

    const normalizedWriteSet = (request.writeSet || []).map(normalizePath).filter(Boolean);

    // 2. Enforce writer concurrency cap on mutating tasks
    if (normalizedWriteSet.length > 0) {
      const activeMutatingCount = Array.from(this.activeClaims.values()).filter(
        (c) => c.writeSet && c.writeSet.length > 0
      ).length;

      if (activeMutatingCount >= this.writerCap) {
        return {
          admitted: false,
          reason: 'WRITER_CAP_EXCEEDED',
          attemptIndex: nextAttempt,
        };
      }
    }

    // 3. Enforce write-set disjointness collision check
    const collision = this.checkWriteSetCollision(normalizedWriteSet);
    if (collision.conflict) {
      return {
        admitted: false,
        reason: 'WRITE_SET_CONFLICT',
        conflicts: {
          conflictingTaskId: collision.conflictingTaskId!,
          overlappingFiles: collision.overlappingFiles!,
        },
        attemptIndex: nextAttempt,
      };
    }

    // 4. Register active claim
    this.taskAttempts.set(request.taskId, nextAttempt);
    const claim: ActiveClaim = {
      taskId: request.taskId,
      runKey: request.runKey,
      attempt: nextAttempt,
      agentRole: request.agentRole,
      workerIdentity: request.workerIdentity,
      writeSet: normalizedWriteSet,
      claimedAt: new Date().toISOString(),
    };
    this.activeClaims.set(request.taskId, claim);

    return {
      admitted: true,
      reason: 'ADMITTED',
      attemptIndex: nextAttempt,
    };
  }

  /**
   * Releases an active claim upon worker completion, failure, or cancellation.
   */
  releaseTask(request: TaskReleaseRequest): void {
    if (!request || !request.taskId) return;
    this.activeClaims.delete(request.taskId);
  }

  /**
   * Returns all currently active claims in the state store.
   */
  getActiveClaims(): ActiveClaim[] {
    return Array.from(this.activeClaims.values());
  }

  /**
   * Resets recorded task attempts (useful for clean test executions).
   */
  resetTaskAttempts(taskId?: string): void {
    if (taskId) {
      this.taskAttempts.delete(taskId);
    } else {
      this.taskAttempts.clear();
    }
  }
}

module.exports = {
  AdmissionController,
  AdmissionError,
  resolveTeamSettings,
};
