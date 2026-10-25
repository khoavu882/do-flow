'use strict';

export type LoginState = 'logged-in' | 'logged-out' | 'unsupported' | 'error';
export type DetectedMode = 'subscription' | 'api-key' | 'unverified';
export type DerivedBilling = 'free' | 'metered' | 'unknown';

export interface OfferedModel {
  id: string;
  displayName?: string;
  family?: string;
}

export interface HarnessQuota {
  status: 'ok' | 'exceeded' | 'unknown';
  message?: string;
}

export interface SyncHarnessResult {
  harnessId: string;
  binary: string;
  installed: boolean;
  version: string | null;
  loginState: LoginState;
  reloginHint: string | null;
  detectedMode: DetectedMode;
  derivedBilling: DerivedBilling;
  offeredModels: Array<OfferedModel>;
  quota?: HarnessQuota;
  lastSyncedAt: string;
}

export type ObservedHarness = SyncHarnessResult;

export interface ObservedCatalogue {
  version: number;
  syncedAt: string;
  harnesses: Record<string, ObservedHarness>;
}
