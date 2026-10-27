'use strict';
// 093 V.2: the marker scan for the synthetic V8 transcript fixtures (IC-022, IC-026). V.4's reader tests
// reuse FIXTURES, MARKERS and scanFixtures(); the tiny test test/runtime/transcript-fixtures.test.ts runs it.
//
// scanFixtures() returns findings (an empty list is a pass):
//   - every text-bearing fixture holds every marker that applies to its kind;
//   - the README lists every marker (by its `display`) and states the no-real-content rule;
//   - no fixture holds this machine's home path, the user's email or a session id from this machine
//     (read from directory NAMES only, never from any file's content);
//   - the files under v8/ are exactly the ones FIXTURES lists, so a stray or deleted file is found.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V8_ROOT = __dirname;

/** Where each harness fixture directory belongs under a scratch HOME (the registry's `home` location). */
const LOCATION_ROOTS: Record<string, string[]> = {
  claude: ['.claude', 'projects'],
  codex: ['.codex', 'sessions'],
  kiro: ['.kiro', 'sessions', 'cli'],
  copilot: ['.copilot', 'session-state'],
  pi: ['.pi', 'agent', 'sessions'],
  // git ignores a directory named `logs/`, so the file sits at <id>/transcript.jsonl; a scratch-home
  // builder places it under <id>/.system_generated/logs/ (core/registry/transcripts.json).
  antigravity: ['.gemini', 'antigravity-cli', 'brain'],
  opencode: ['.local', 'share', 'opencode'],
};

const MAIN = 'fa000000-0000-4000-8000-00000000';
type Kind = 'main' | 'subagent' | 'other-project' | 'companion' | 'opaque';
interface Fixture { harness: string; file: string; kind: Kind; sessionId: string | null; cwd: string | null }

const P = '/work/fixture-project';
const O = '/work/other-project';
/** Every file under v8/ except README.md and scan.ts; `file` is relative to v8/. */
const FIXTURES: Fixture[] = [
  { harness: 'claude', file: `claude/-work-fixture-project/${MAIN}c001.jsonl`, kind: 'main', sessionId: `${MAIN}c001`, cwd: P },
  { harness: 'claude', file: `claude/-work-fixture-project/${MAIN}c001/subagents/agent-afx1.jsonl`, kind: 'subagent', sessionId: `${MAIN}c001`, cwd: P },
  { harness: 'claude', file: `claude/-work-fixture-project/${MAIN}c001/subagents/agent-afx1.meta.json`, kind: 'companion', sessionId: `${MAIN}c001`, cwd: null },
  { harness: 'claude', file: `claude/-work-fixture-project/${MAIN}c001/subagents/agent-afx2.jsonl`, kind: 'subagent', sessionId: `${MAIN}c001`, cwd: P },
  { harness: 'claude', file: `claude/-work-fixture-project/${MAIN}c001/subagents/agent-afx2.meta.json`, kind: 'companion', sessionId: `${MAIN}c001`, cwd: null },
  { harness: 'claude', file: `claude/-work-other-project/${MAIN}c0f2.jsonl`, kind: 'other-project', sessionId: `${MAIN}c0f2`, cwd: O },
  { harness: 'codex', file: `codex/2026/01/01/rollout-2026-01-01T00-00-00-${MAIN}d001.jsonl`, kind: 'main', sessionId: `${MAIN}d001`, cwd: P },
  { harness: 'codex', file: `codex/2026/01/01/rollout-2026-01-01T00-00-30-${MAIN}d002.jsonl`, kind: 'subagent', sessionId: `${MAIN}d002`, cwd: P },
  { harness: 'codex', file: `codex/2026/01/01/rollout-2026-01-01T00-01-00-${MAIN}d0f3.jsonl`, kind: 'other-project', sessionId: `${MAIN}d0f3`, cwd: O },
  { harness: 'kiro', file: `kiro/${MAIN}e001.jsonl`, kind: 'main', sessionId: `${MAIN}e001`, cwd: P },
  { harness: 'kiro', file: `kiro/${MAIN}e001.json`, kind: 'companion', sessionId: `${MAIN}e001`, cwd: P },
  { harness: 'copilot', file: `copilot/${MAIN}f001/events.jsonl`, kind: 'main', sessionId: `${MAIN}f001`, cwd: P },
  { harness: 'copilot', file: `copilot/${MAIN}f001/workspace.yaml`, kind: 'companion', sessionId: `${MAIN}f001`, cwd: P },
  { harness: 'pi', file: `pi/--work-fixture-project--/2026-01-01T00-00-00-000Z_${MAIN}a001.jsonl`, kind: 'main', sessionId: `${MAIN}a001`, cwd: P },
  { harness: 'pi', file: `pi/--work-fixture-project--/2026-01-01T00-00-30-000Z_${MAIN}a002.jsonl`, kind: 'subagent', sessionId: `${MAIN}a002`, cwd: P },
  { harness: 'pi', file: `pi/--work-other-project--/2026-01-01T00-01-00-000Z_${MAIN}a0f3.jsonl`, kind: 'other-project', sessionId: `${MAIN}a0f3`, cwd: O },
  { harness: 'antigravity', file: `antigravity/${MAIN}b001/transcript.jsonl`, kind: 'main', sessionId: `${MAIN}b001`, cwd: null },
  { harness: 'opencode', file: 'opencode/opencode.db', kind: 'opaque', sessionId: null, cwd: null },
  { harness: 'opencode', file: 'opencode/opencode.db-wal', kind: 'opaque', sessionId: null, cwd: null },
  { harness: 'opencode', file: 'opencode/opencode.db-shm', kind: 'opaque', sessionId: null, cwd: null },
];

const TEXT_KINDS: Kind[] = ['main', 'subagent', 'other-project'];
interface Marker { id: string; display: string; test: (text: string) => boolean; kinds: Kind[] }
const has = (needle: string) => (text: string) => text.includes(needle);

/** Planted in every text-bearing fixture (the README lists each by `display`). */
const MARKERS: Marker[] = [
  { id: 'secret-reply', display: 'password=fx-Secret-4471-reply', test: has('password=fx-Secret-4471-reply'), kinds: TEXT_KINDS },
  { id: 'secret-args-plain', display: 'password=fx-Secret-4471-args', test: has('password=fx-Secret-4471-args'), kinds: TEXT_KINDS },
  {
    id: 'secret-args-escaped', display: '\\"token\\":\\"fx-Secret-4471-esc\\"',
    test: (text) => /\\+"token\\+":\s*\\+"fx-Secret-4471-esc/.test(text), kinds: TEXT_KINDS,
  },
  { id: 'email', display: 'fixture.person@example.invalid', test: has('fixture.person@example.invalid'), kinds: TEXT_KINDS },
  { id: 'thinking', display: 'FIXTURE-THINKING-MARKER-7f3a', test: has('FIXTURE-THINKING-MARKER-7f3a'), kinds: TEXT_KINDS },
  { id: 'user-prompt', display: 'FIXTURE-USER-PROMPT-MARKER-91c2', test: has('FIXTURE-USER-PROMPT-MARKER-91c2'), kinds: TEXT_KINDS },
  {
    id: 'attachment-user-email', display: '"userEmail":"fixture.attach@example.invalid"',
    test: has('"userEmail":"fixture.attach@example.invalid"'), kinds: TEXT_KINDS,
  },
  { id: 'unknown-record-type', display: 'fixture-unknown-record-type', test: has('fixture-unknown-record-type'), kinds: TEXT_KINDS },
  { id: 'missing-keys-record', display: 'fixture-missing-keys-record', test: has('fixture-missing-keys-record'), kinds: TEXT_KINDS },
  { id: 'path', display: '/work/fixture-project/notes/private.txt', test: has('/work/fixture-project/notes/private.txt'), kinds: TEXT_KINDS },
  { id: 'tool-result-text', display: 'FIXTURE-TOOL-RESULT-TEXT-5e1d', test: has('FIXTURE-TOOL-RESULT-TEXT-5e1d'), kinds: TEXT_KINDS },
  { id: 'other-project-reply', display: 'FIXTURE-OTHER-PROJECT-REPLY-2b8d', test: has('FIXTURE-OTHER-PROJECT-REPLY-2b8d'), kinds: ['other-project'] },
];

/** What must not appear in any fixture: this machine's home path, the user's email, its session ids. */
interface Forbidden { homeDirs: string[]; emails: string[]; sessionIds: string[] }

function listNames(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Read from the real account, not from $HOME (tests run under a scratch HOME). Directory NAMES only. */
function realMachineIdentity(): Forbidden {
  const realHome: string = os.userInfo().homedir;
  const homeDirs = [...new Set([realHome, os.homedir()])].filter((dir) => path.isAbsolute(dir) && dir.length > 3);
  const emails = new Set<string>();
  for (const file of [path.join(realHome, '.gitconfig'), path.join(realHome, '.config', 'git', 'config')]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
    for (const m of text.matchAll(/^\s*email\s*=\s*(\S+@\S+)\s*$/gm)) emails.add(m[1]);
  }
  for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    const value = process.env[name];
    if (value && value.includes('@')) emails.add(value);
  }
  const ids = new Set<string>();
  for (const dir of [path.join(realHome, '.claude', 'session-env', 'sessions'), path.join(realHome, '.config', 'doflow', 'session-env', 'sessions')]) {
    for (const name of listNames(dir)) if (name.length >= 8) ids.add(name);
  }
  return { homeDirs, emails: [...emails], sessionIds: [...ids] };
}

function walk(dir: string, base: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function scanFixtures({ root = V8_ROOT, forbidden = realMachineIdentity() }: { root?: string; forbidden?: Forbidden } = {}): string[] {
  const findings: string[] = [];
  const onDisk = walk(root, root, []).filter((file) => file !== 'README.md' && file !== 'scan.ts').sort();
  const listed = FIXTURES.map((fx) => fx.file).sort();
  for (const file of onDisk) if (!listed.includes(file)) findings.push(`${file}: a file under v8/ that FIXTURES does not list`);
  for (const file of listed) if (!onDisk.includes(file)) findings.push(`${file}: listed in FIXTURES but missing`);

  const readme = fs.existsSync(path.join(root, 'README.md')) ? fs.readFileSync(path.join(root, 'README.md'), 'utf8') : '';
  if (!readme) findings.push('README.md: missing');
  if (readme && !readme.includes('NO REAL CONTENT')) findings.push('README.md: does not state the NO REAL CONTENT rule');
  for (const marker of MARKERS) {
    if (readme && !readme.includes(marker.display)) findings.push(`README.md: does not list marker ${marker.id} (${marker.display})`);
  }

  for (const fx of FIXTURES) {
    const full = path.join(root, fx.file);
    if (!fs.existsSync(full)) continue;
    const text: string = fs.readFileSync(full).toString('latin1');
    for (const marker of MARKERS) {
      if (marker.kinds.includes(fx.kind) && !marker.test(text)) findings.push(`${fx.file}: marker ${marker.id} is not planted`);
      if (!marker.kinds.includes(fx.kind) && fx.kind !== 'opaque' && marker.test(text) && marker.id === 'other-project-reply') {
        findings.push(`${fx.file}: marker ${marker.id} belongs only to an other-project fixture`);
      }
    }
    if (fx.kind === 'opaque' && !text.startsWith('FIXTURE-OPENCODE-')) findings.push(`${fx.file}: not the fixed fixture bytes`);
  }

  // Everything under v8/ (the README and this helper excluded: they name the rules, not the values).
  for (const file of onDisk) {
    const text: string = fs.readFileSync(path.join(root, file)).toString('latin1');
    for (const dir of forbidden.homeDirs) if (text.includes(dir)) findings.push(`${file}: holds the machine's home path`);
    for (const email of forbidden.emails) if (text.toLowerCase().includes(email.toLowerCase())) findings.push(`${file}: holds the user's email`);
    for (const id of forbidden.sessionIds) if (text.includes(id)) findings.push(`${file}: holds a session id from this machine`);
  }
  return findings;
}

module.exports = { V8_ROOT, FIXTURES, MARKERS, LOCATION_ROOTS, realMachineIdentity, scanFixtures };
