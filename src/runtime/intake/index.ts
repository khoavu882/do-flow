'use strict';

/**
 * The `intake` verb (136 IC-001): `doflow-run intake --action <sort|preview|undo|list|file-prompt>`. This module
 * resolves the feature folder, runs the engine's action and maps its result to an exit status; it never
 * prompts. Exit 0 = done (a sort with zero moves too), 1 = a finding to act on (a sort or undo that skipped or
 * failed an entry, or an undo with nothing left to undo), 2 = the call cannot proceed (no active feature, an
 * unknown action, no input for `file-prompt`, a manifest from a newer schema, a lock that could not be taken).
 * `--json` prints the engine's object unmodified.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { resolveActiveFeature } = require('../feature-resolve.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { loadTaxonomy } = require('./taxonomy.ts');
const { IntakeUsageError } = require('./manifest.ts');
const { previewSort, sortFolder, undoRun, listFolder, filePrompt, CONTEXT_DIR } = require('./engine.ts');

const VALID_ACTIONS = ['sort', 'preview', 'undo', 'list', 'file-prompt'];

/** The prompt text as bytes, unchanged: from `--stdin` or from `--file <path>`. */
function readInput({ stdin, file }: any, fsImpl: any): Buffer {
  if (!stdin && !file) throw new IntakeUsageError('--action file-prompt needs the text from --stdin or --file <path>');
  if (stdin && file) throw new IntakeUsageError('--stdin and --file cannot be combined');
  try {
    return stdin ? fsImpl.readFileSync(0) : fsImpl.readFileSync(path.resolve(file));
  } catch (error: any) {
    throw new IntakeUsageError(`cannot read ${stdin ? 'stdin' : `--file ${file}`}: ${error.message}`);
  }
}

/**
 * Runs one action and returns its result without printing.
 * @returns {{exitCode:number, result?:Object, usage?:string}}
 */
function runIntake({ action, projectRoot, slug = null, flags = {}, now = new Date(), fsImpl = nodeFs, taxonomyOptions = {} }: any): { exitCode: number; result?: any; usage?: string } {
  try {
    if (!VALID_ACTIONS.includes(action)) throw new IntakeUsageError(`unknown --action '${action}'. Valid: ${VALID_ACTIONS.join(', ')}`);
    const feature = resolveActiveFeature({ projectRoot, slug });
    if (feature.error) throw new IntakeUsageError(feature.message);
    const loaded = loadTaxonomy({ ...taxonomyOptions, fsImpl });
    if (!loaded.ok) throw new IntakeUsageError(`the intake categories cannot be used (${loaded.reason}): ${loaded.detail}`);
    const common = { contextDir: path.join(feature.featureFolder, CONTEXT_DIR), taxonomy: loaded.taxonomy, now, fsImpl };
    let result: any;
    if (action === 'sort') result = sortFolder(common);
    else if (action === 'preview') result = previewSort(common);
    else if (action === 'list') result = listFolder(common);
    else if (action === 'undo') result = undoRun({ ...common, runId: flags.runId || null });
    else result = filePrompt({ ...common, bytes: readInput(flags, fsImpl), stage: flags.stage || null });
    const finding = (Array.isArray(result.skipped) && result.skipped.length > 0) || result.state === 'nothing-to-undo';
    return { exitCode: finding ? 1 : 0, result };
  } catch (error: any) {
    if (error instanceof IntakeUsageError) return { exitCode: 2, usage: error.message };
    // Another writer holds the manifest lock: the call cannot proceed now (IC-001), so it is usage, not a finding.
    if (/^Could not lock/.test(error?.message || '')) return { exitCode: 2, usage: error.message };
    throw error;
  }
}

function humanLines(result: any): string[] {
  const lines: string[] = [];
  if (result.state === 'absent') return [`no ${CONTEXT_DIR} folder in this feature; nothing to ${result.action}`];
  if (result.action === 'sort' || result.action === 'preview') {
    for (const move of result.moves) lines.push(`${result.action === 'preview' ? 'would move' : 'moved'} ${move.from} -> ${move.to}  [${move.category}]`);
    for (const skip of result.skipped) lines.push(`skipped ${skip.path} (${skip.reason}${skip.detail ? `: ${skip.detail}` : ''})`);
    lines.push(`${result.moves.length} ${result.action === 'preview' ? 'to move' : 'moved'}, ${result.skipped.length} skipped, ${result.unmatched.length} unmatched${result.runId ? `; undo with --action undo --run-id ${result.runId}` : ''}`);
  } else if (result.action === 'undo') {
    if (result.state === 'nothing-to-undo') return ['no run left to undo'];
    for (const move of result.restored) lines.push(`restored ${move.to} -> ${move.from}`);
    for (const skip of result.skipped) lines.push(`skipped ${skip.to} (${skip.reason})`);
    for (const dir of result.removedDirs) lines.push(`removed empty folder ${dir}`);
    lines.push(`${result.restored.length} restored, ${result.skipped.length} skipped (${result.runId})`);
  } else if (result.action === 'list') {
    for (const file of result.files) lines.push(`${file.path}  ${file.category ?? '-'}  ${file.kind}  ${file.bytes} bytes  ${file.sha256}${file.pointer ? '  pointer' : ''}`);
    lines.push(`${result.files.length} file${result.files.length === 1 ? '' : 's'}`);
  } else {
    lines.push(`filed ${result.path} (${result.bytes} bytes, ${result.sha256}; ${result.runId})`);
  }
  return lines;
}

/** `intake` verb. Exit 0 = done, 1 = a finding, 2 = usage. `--json` prints the result object unmodified. */
function handleIntakeCommand({ action = 'sort', projectRoot, slug = null, json = false, flags = {} }: any = {}): number {
  const run = runIntake({ action, projectRoot: projectRoot || process.cwd(), slug, flags });
  if (run.usage !== undefined) return usageError('intake', run.usage, json);
  if (json) console.log(JSON.stringify(run.result, null, 2));
  else for (const line of humanLines(run.result)) console.log(line);
  return finishRuntime(run.exitCode);
}

module.exports = { handleIntakeCommand, runIntake, humanLines, VALID_ACTIONS };
