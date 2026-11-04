'use strict';

/**
 * `doflow roadmap --action init-policy --commit`: a person-run command, kept out of src/runtime/roadmap/**
 * so the autopilot loop's git reach (G53, G54) does not widen. It adds one commit to the local develop that
 * touches only core/registry/gates.json, built with git plumbing in a temporary index so the index, the
 * working tree and the checked-out branch stay as they are. The bytes are the reviewed working copy when
 * there is one, else the packaged policy; invalid bytes are refused. A develop checked out in any worktree
 * is not moved (that worktree's index would go stale): the commands to run there are printed instead. The
 * ref moves with compare-and-swap. Nothing is staged, pushed, tagged or published, and the loop still reads
 * the policy only from develop's committed head.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { loadPolicy } = require('./roadmap/gates.ts');
const { resolveMainRoot } = require('./roadmap/loop.ts');

const REL = 'core/registry/gates.json';
const MESSAGE = 'chore(roadmap): add the autopilot gate policy';
const shellQuote = (text: string): string => ["'", text.split("'").join("'\\''"), "'"].join('');

/** Every git command addresses the named checkout; inherited routing variables are dropped. */
function optionsFor(root: string, env: any): any {
  const environment = { ...env };
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete environment[key];
  return { cwd: root, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
}

/** The path of the worktree that has `ref` checked out, if any. */
function checkedOutAt(execFileSync: any, root: string, opts: any, ref: string): string | undefined {
  const out = String(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], opts));
  for (const block of out.split('\0\0').filter(Boolean)) {
    const fields = block.split('\0');
    const listed = fields.find((s) => s.startsWith('worktree '))?.slice(9);
    if (listed && fields.find((s) => s.startsWith('branch '))?.slice(7) === ref) return path.resolve(listed);
  }
  return undefined;
}

function commitPolicyCommand(options: any): number {
  const { json = false, fsImpl = fs } = options;
  const root = options.root || resolveMainRoot(options.cwd || process.cwd());
  const execFileSync = options.execFileSync || defaultExecFileSync;
  const opts = optionsFor(root, options.env || process.env);
  const target = path.join(root, REL);
  const packaged = path.join(options.repoRoot, REL);
  const reason = (error: any): string => String(error?.stderr || error?.message || error).trim();
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ schema: 1, action: 'init-policy', error: 'not-committed', detail: message }));
    else console.error(`doflow roadmap: ${message}`);
    process.exitCode = 1;
    return 1;
  };

  let old: string;
  try { old = String(execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'refs/heads/develop'], opts)).trim(); }
  catch { return fail('no local develop branch (or not a git repository); create develop first, the loop reads the policy only from its head'); }
  let present = true;
  try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${old}:${REL}`], opts); } catch { present = false; }
  if (present) return fail(`develop already has ${REL}; nothing changed`);

  let workingCopy: any = null;
  try { workingCopy = fsImpl.readFileSync(target); }
  catch (error: any) { if (error.code !== 'ENOENT') return fail(`cannot read ${target}: ${error.message}`); }
  const bytes = workingCopy ?? fsImpl.readFileSync(packaged);
  const verdict = loadPolicy(bytes);
  if (!verdict.ok) return fail(`${workingCopy ? target : 'the packaged policy'} is not a valid policy (${verdict.reason}); nothing changed`);

  const elsewhere = checkedOutAt(execFileSync, root, opts, 'refs/heads/develop');
  if (elsewhere) {
    const destination = path.join(elsewhere, REL);
    const source = workingCopy ? target : packaged;
    const commands = [`mkdir -p ${shellQuote(path.dirname(destination))}`];
    if (path.resolve(source) !== path.resolve(destination)) commands.push(`cp ${shellQuote(source)} ${shellQuote(destination)}`);
    commands.push(`git -C ${shellQuote(elsewhere)} add -- ${REL}`, `git -C ${shellQuote(elsewhere)} commit -m ${shellQuote(MESSAGE)} -- ${REL}`);
    return fail(`develop is checked out at ${elsewhere}; moving its branch would leave that worktree's index stale, so nothing was changed. Run instead:\n  ${commands.join('\n  ')}`);
  }

  // git itself creates and locks this temporary index (read-tree, update-index, write-tree); this module writes no file.
  const scratch = path.join(os.tmpdir(), `doflow-policy-${crypto.randomBytes(8).toString('hex')}.index`);
  const indexed = { ...opts, env: { ...opts.env, GIT_INDEX_FILE: scratch } };
  let commit: string;
  try {
    const blob = String(execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { ...opts, stdio: ['pipe', 'pipe', 'pipe'], input: bytes })).trim();
    execFileSync('git', ['-C', root, 'read-tree', old], indexed);
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `100644,${blob},${REL}`], indexed);
    const tree = String(execFileSync('git', ['-C', root, 'write-tree'], indexed)).trim();
    commit = String(execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', old, '-m', MESSAGE, '--no-gpg-sign'], opts)).trim();
  } catch (error: any) {
    return fail(`cannot build the commit: ${reason(error)}; nothing changed`);
  } finally {
    for (const leftover of [scratch, `${scratch}.lock`]) fsImpl.rmSync(leftover, { force: true });
  }
  try { execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/develop', commit, old], opts); }
  catch (error: any) { return fail(`develop moved or could not be updated (${reason(error)}); nothing changed, run the command again`); }

  // The working copy is now tracked on develop: an identical untracked copy would collide with a later merge of develop.
  let copy = 'none';
  let copyNote = '';
  if (workingCopy) {
    let tracked = false;
    try { tracked = String(execFileSync('git', ['-C', root, 'ls-files', '--', REL], opts)).trim() !== ''; } catch { /* untracked */ }
    let now: any = null;
    try { now = fsImpl.readFileSync(target); } catch { /* gone already */ }
    if (tracked) { copy = 'kept'; copyNote = `kept ${target}: it is tracked in the checked-out branch`; }
    else if (now && Buffer.from(now).equals(Buffer.from(bytes))) { fsImpl.unlinkSync(target); copy = 'removed'; copyNote = `removed ${target} (identical to the committed bytes, now tracked on develop)`; }
    else if (now) { copy = 'kept'; copyNote = `kept ${target}: it differs from the committed bytes`; }
  }
  if (json) console.log(JSON.stringify({ schema: 1, action: 'init-policy', committed: true, commit, previous: old, file: REL, root, workingCopy: copy }));
  else console.log(`develop ${old} -> ${commit} (${REL} only)${copyNote ? `\n${copyNote}` : ''}\nNothing was pushed; that is yours.`);
  return 0;
}

module.exports = { commitPolicyCommand };
