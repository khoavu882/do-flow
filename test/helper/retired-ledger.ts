'use strict';

// retired-ledger.ts — a retired harness's install under a scratch root, in the five row shapes of
// row 127 design D2, with the retired id and its replacement as parameters (`oldtool` -> `antigravity`
// in the module tests, `gemini` -> `antigravity` in the end-to-end ones). Synthetic rows only: the
// real ledger is never copied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultLedger } = require('../../src/state/index.ts');
const { MARKER_START, MARKER_END } = require('../../src/helper/marker-merge.ts');

const HOOK_SCRIPTS = ['session-start.sh', 'session-end.sh', 'pre-bash-guard.sh', 'mcp-tool-guard.sh', 'pre-implement-gate.sh', 'post-edit-lint.sh', 'pre-compact.sh'];

const sha = (bytes: any): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** The command the retired harness's hooks.json wired for one script; for `gemini` these are the
 * frozen strings of core/harnesses/gemini/hooks/hooks.json @ c35f681b. */
function hookCommand(id: string, script: string): string {
  return `bash "$${id.toUpperCase().replace(/-/g, '_')}_PROJECT_DIR/.${id}/hooks/${script}"`;
}

/** An IC-001 retired record for `id`. */
function retiredRecord({ id = 'oldtool', replacement = 'antigravity', handover = [] as any[] } = {}): any {
  return {
    id, displayName: id, replacement, retiredOn: '2026-10-26', reason: 'test fixture', evidence: ['test'],
    removal: {
      hookCommands: { renderer: `${id}-hooks`, key: 'hooks', commands: HOOK_SCRIPTS.map((script) => hookCommand(id, script)) },
      markerSectionRenderers: [`${id}-instructions`], handover,
    },
  };
}

/** The user's own text and handlers, which must survive the sweep. */
const USER_TEXT = '# My notes\n\nKeep this.\n';
const USER_HANDLER = { type: 'command', command: 'echo mine' };
const USER_KEYS = { mcpServers: { mine: { command: 'my-server' } }, security: { auth: { selectedType: 'oauth' } } };

function write(file: string, content: any): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Lays out under `root`:
 *  shared      <root>/.doflow/guidance/CORE.md   copy-tree-file, also claimed by `replacement` (release)
 *  agent       <root>/.<id>/agents/helper.md     copy-tree-file (agents.shared), unshared (delete)
 *  script      <root>/.<id>/hooks/<script>        hooks-script / <id>-hooks, one per HOOK_SCRIPTS (delete)
 *  instructions <root>/.<id>/<ID>.md             no kind / <id>-instructions, user text + span (strip-section)
 *  settings    <root>/.<id>/settings.json         no kind / <id>-hooks, DoFlow + user handlers (strip-hooks)
 * Returns the ledger, a registry with the retired record, every target and the rows by name.
 */
function buildRetiredLedger({ root, id = 'oldtool', replacement = 'antigravity', scope = 'global', handover = [] as any[] }: any): any {
  const dir = path.join(root, `.${id}`);
  const row = (fields: any) => ({ scope, sourceVersion: 'test', ...fields });
  const fileRow = (harness: string, assetId: string, target: string, identity: string) => row({
    harness, assetId, target, kind: 'copy-tree-file', identity, fingerprint: sha(fs.readFileSync(target)),
    ownershipIdentity: `doflow:${harness}:copy-tree:${assetId}:${identity}`, projection: { renderer: 'copy-tree' },
  });

  const shared = write(path.join(root, '.doflow', 'guidance', 'CORE.md'), '# core\n');
  const agent = write(path.join(dir, 'agents', 'helper.md'), '---\nname: helper\n---\nbody\n');
  const scripts = Object.fromEntries(HOOK_SCRIPTS.map((script) => [script, write(path.join(dir, 'hooks', script), `#!/bin/bash\n# ${script}\n`)]));
  const instructions = write(path.join(dir, `${id.toUpperCase()}.md`), `${USER_TEXT}\n${MARKER_START}\nDoFlow pointer\n${MARKER_END}\n`);
  const doflowHandler = (script: string) => ({ type: 'command', command: hookCommand(id, script) });
  const settingsDoc = {
    ...USER_KEYS,
    hooks: {
      SessionStart: [{ hooks: [doflowHandler('session-start.sh')] }, { hooks: [USER_HANDLER] }],
      BeforeTool: [{ matcher: '^run_shell_command$', hooks: [doflowHandler('pre-bash-guard.sh'), USER_HANDLER] }],
      AfterTool: [{ matcher: '^(write_file|replace)$', hooks: [doflowHandler('post-edit-lint.sh')] }],
    },
  };
  const settings = write(path.join(dir, 'settings.json'), `${JSON.stringify(settingsDoc, null, 2)}\n`);

  const rows = {
    shared: fileRow(id, 'guidance.context-layer', shared, 'CORE.md'),
    sharedLive: fileRow(replacement, 'guidance.context-layer', shared, 'CORE.md'),
    agent: fileRow(id, 'agents.shared', agent, 'helper.md'),
    scripts: HOOK_SCRIPTS.map((script) => row({
      harness: id, assetId: 'guidance.core', target: scripts[script], kind: 'hooks-script', identity: script,
      fingerprint: sha(fs.readFileSync(scripts[script])), ownershipIdentity: `${id}:hooks-script:${script}`, projection: { renderer: `${id}-hooks` },
    })),
    instructions: row({ harness: id, assetId: 'guidance.core', target: instructions, ownershipIdentity: `${id}:instructions`,
      fingerprint: sha(fs.readFileSync(instructions)), projection: { renderer: `${id}-instructions` } }),
    settings: row({ harness: id, assetId: 'guidance.core', target: settings, ownershipIdentity: `${id}:hooks`,
      fingerprint: sha(JSON.stringify(settingsDoc.hooks)), projection: { renderer: `${id}-hooks` } }),
  };
  const ledger = defaultLedger({ scope, scopeRoot: root });
  ledger.resources = [rows.shared, rows.sharedLive, rows.agent, ...rows.scripts, rows.instructions, rows.settings];
  ledger.targets = { [id]: { installed: true }, [replacement]: { installed: true } };
  const record = retiredRecord({ id, replacement, handover });
  const registry = { harnesses: [{ id: replacement }], retired: [record] };
  return { ledger, registry, record, rows, targets: { shared, agent, scripts, instructions, settings }, settingsDoc };
}

module.exports = { buildRetiredLedger, retiredRecord, hookCommand, HOOK_SCRIPTS, USER_TEXT, USER_HANDLER, USER_KEYS, sha };
