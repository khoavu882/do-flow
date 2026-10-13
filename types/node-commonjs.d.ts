// Minimal ambient declarations for the CommonJS globals DoFlow's TypeScript runtime modules use.
// DoFlow runs .ts through Node native type-stripping with ZERO dependencies (no @types/node), so
// the handful of Node globals the `.ts` bodies reference are declared here rather than pulled from
// a devDependency. Kept intentionally narrow: this is not a re-implementation of @types/node, only
// the surface the migrated modules actually touch. Extend it as more modules migrate, not ahead of
// need. See agent-docs/BRIEF_GOAL_DOFLOW.md for the migration roadmap.

declare var require: { (id: string): any; main: any };

declare var module: { exports: any };

declare var process: {
  features?: { typescript?: false | 'strip' | 'transform' };
  env: Record<string, string | undefined>;
  platform: string;
  execPath: string;
  version: string;
  pid: number;
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  exitCode?: number;
  kill(pid: number, signal?: string | number): void;
  hrtime: { (time?: [number, number]): [number, number]; bigint(): bigint };
  stdin: { isTTY?: boolean; isRaw?: boolean; setRawMode(mode: boolean): void };
  stdout: { write(chunk: string): boolean; isTTY?: boolean };
  stderr: { write(chunk: string): boolean };
  on(event: string, listener: (...args: any[]) => void): any;
  removeListener(event: string, listener: (...args: any[]) => void): any;
};

declare var __dirname: string;
declare var __filename: string;

// Narrow Buffer / console surface the migrated .ts modules touch. Not a re-implementation of
// @types/node — only what the converted modules reference. Extend as more modules migrate.
declare var console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
};

interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  equals(other: Uint8Array): boolean;
  subarray(begin?: number, end?: number): Buffer;
}
declare var Buffer: {
  alloc(size: number): Buffer;
  from(data: any, encoding?: string): Buffer;
  byteLength(string: string, encoding?: string): number;
  isBuffer(value: any): boolean;
  allocUnsafe(size: number): Buffer;
  concat(list: Uint8Array[], totalLength?: number): Buffer;
};

// Timers and WHATWG URL, as the migrated .ts modules use them (opaque handle; parsed URL fields only).
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;
declare var URL: {
  new (input: string, base?: string): { protocol: string; username: string; password: string; hostname: string; [key: string]: any };
};

// High-resolution clock (storage engine pass budget).
declare var performance: { now(): number };

// structuredClone (workflow-orchestrator previewHandoff deep-copies a run program).
declare function structuredClone<T>(value: T): T;
