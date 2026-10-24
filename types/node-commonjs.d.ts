// Minimal ambient declarations for the CommonJS globals DoFlow's TypeScript runtime modules use.
// DoFlow runs .ts through Node native type-stripping with ZERO dependencies (no @types/node), so
// the handful of Node globals the `.ts` bodies reference are declared here rather than pulled from
// a devDependency. Kept intentionally narrow: this is not a re-implementation of @types/node, only
// the surface the migrated modules actually touch. Extend it as more modules migrate, not ahead of
// need. See agent-docs/BRIEF_GOAL_DOFLOW.md for the migration roadmap.

type TestCallback = (t?: any, done?: any) => any;
interface TestFn {
  (name: string, fn?: TestCallback): any;
  (name: string, opts: any, fn?: TestCallback): any;
  (fn: TestCallback): any;
  skip: TestFn;
  todo: TestFn;
  only: TestFn;
}
interface NodeTestModule {
  test: TestFn;
  describe: TestFn;
  it: TestFn;
  suite: TestFn;
  before(fn: TestCallback, opts?: any): void;
  after(fn: TestCallback, opts?: any): void;
  beforeEach(fn: TestCallback, opts?: any): void;
  afterEach(fn: TestCallback, opts?: any): void;
  mock: any;
  run: any;
  [key: string]: any;
}
interface NodeHttpModule {
  createServer(listener?: (req?: any, res?: any) => any): any;
  [key: string]: any;
}
interface NodeNetModule {
  createServer(opts?: any, listener?: (socket?: any) => any): any;
  [key: string]: any;
}

declare var require: {
  (id: 'node:test'): NodeTestModule;
  (id: 'node:http' | 'http'): NodeHttpModule;
  (id: 'node:net' | 'net'): NodeNetModule;
  (id: string): any;
  main: any;
  resolve(id: string, options?: any): string;
  cache: Record<string, any>;
};

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
  stdin: { isTTY?: boolean; isRaw?: boolean; setRawMode(mode: boolean): void; [key: string]: any };
  stdout: { write(chunk: any, ...rest: any[]): boolean; isTTY?: boolean; columns?: number; [key: string]: any };
  stderr: { write(chunk: any, ...rest: any[]): boolean; [key: string]: any };
  arch: string;
  versions: Record<string, string>;
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; [key: string]: number };
  uptime(): number;
  umask(mask?: number): number;
  getuid?(): number;
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
  emitWarning(warning: any, ...rest: any[]): void;
  once(event: string, listener: (...args: any[]) => void): any;
  off(event: string, listener: (...args: any[]) => void): any;
  emit(event: string, ...args: any[]): boolean;
  chdir(directory: string): void;
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
  info(...args: any[]): void;
  debug(...args: any[]): void;
  table(...args: any[]): void;
  [key: string]: any;
};

interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  equals(other: Uint8Array): boolean;
  subarray(begin?: number, end?: number): Buffer;
  readUInt16LE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  readInt32LE(offset?: number): number;
  readBigInt64LE(offset?: number): bigint;
  readUInt8(offset?: number): number;
  readUInt16BE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
  writeUInt16LE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  write(string: string, offset?: number, length?: number, encoding?: string): number;
  slice(begin?: number, end?: number): Buffer;
  toJSON(): { type: 'Buffer'; data: number[] };
}
declare var Buffer: {
  alloc(size: number): Buffer;
  from(data: any, encoding?: string): Buffer;
  byteLength(string: string, encoding?: string): number;
  isBuffer(value: any): boolean;
  allocUnsafe(size: number): Buffer;
  concat(list: Uint8Array[], totalLength?: number): Buffer;
  compare(a: Uint8Array, b: Uint8Array): number;
  prototype: Buffer;
};

// Timers and WHATWG URL, as the migrated .ts modules use them (opaque handle; parsed URL fields only).
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(handle: any): void;
declare var URL: {
  new (input: string, base?: string): { protocol: string; username: string; password: string; hostname: string; [key: string]: any };
};

// High-resolution clock (storage engine pass budget).
declare var performance: { now(): number };

// structuredClone (workflow-orchestrator previewHandoff deep-copies a run program).
declare function structuredClone<T>(value: T): T;

// Ambient globals used by test/ and bench/ (all present in Node >=24; declared loosely, no @types/node).
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(handle: any): void;
declare function queueMicrotask(callback: () => void): void;
declare function fetch(input: any, init?: any): Promise<any>;
declare var AbortController: { new (): { signal: any; abort(reason?: any): void }; prototype: any };
declare var AbortSignal: { new (): any; abort(reason?: any): any; timeout(ms: number): any; any(signals: any[]): any; prototype: any };
declare var TextEncoder: { new (): { encode(input?: string): Uint8Array; encoding: string } };
declare var TextDecoder: { new (label?: string, options?: any): { decode(input?: any, options?: any): string; encoding: string } };
declare var URLSearchParams: { new (init?: any): any; prototype: any };
declare var EventTarget: { new (): any; prototype: any };
declare var Event: { new (type: string, init?: any): any; prototype: any };
