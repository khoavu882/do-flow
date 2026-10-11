/**
 * DoFlow Runtime Type Declarations
 *
 * Provides ambient type definitions for core runtime contracts and schemas:
 * ContextPack, VerificationContract, CapabilityRouter, DecisionRegister, and OutcomeRecord.
 */

export interface ContextPackOptions {
  taskId: string;
  taskClass?: string;
  maxBytes?: number;
  objective?: string;
  mandatory?: {
    acceptanceCriteria?: string[];
    constraints?: string[];
    verificationPlan?: string;
  };
  optional?: {
    hypotheses?: string[];
    narrative?: string[];
    unverifiedClaims?: string[];
  };
  evidenceLedger?: unknown;
  claimsManager?: unknown;
  researchRequests?: unknown[];
  decisions?: {
    available: boolean;
    live: unknown[];
    liveCount: number;
    reason?: string;
  };
}

export interface ContextPackResult {
  taskId: string;
  taskClass: string;
  totalBytes: number;
  budgetBytes: number;
  overflow: boolean;
  mandatoryBytes: number;
  optionalBytes: number;
  omissions: Array<{ id: string; reason: string }>;
  payload: string;
  error?: string;
}

export interface LatencyBudget {
  surface: string;
  command: string[];
  ceilingMs: number;
}

export interface DecisionRecord {
  id: string;
  topic: string;
  statement: string;
  decidedBy: 'user' | 'agent';
  channel: 'question' | 'gate' | 'prompt' | 'default' | 'resolution';
  stage: 'discovery' | 'design' | 'planning' | 'implementation' | 'verification' | 'review';
  rationale: string;
  status: 'live' | 'superseded';
  supersedes: string[];
  refs: string[];
  date: string;
  at: string;
}

export interface VerificationContract {
  taskId: string;
  featureSlug: string;
  allowedPaths: string[];
  mandatoryTiers: string[];
  requiredSuites: string[];
  baselineRef?: string;
  compiledAt: string;
}

export interface VerificationReport {
  taskId: string;
  passed: boolean;
  tiers: Record<string, { passed: boolean; message?: string }>;
  evidence: unknown[];
  evaluatedAt: string;
}

export interface CapabilityCandidate {
  provider: string;
  intent: string;
  priority: number;
  healthy: boolean;
}
