'use strict';

// Asks a harness's own CLI which model ids it offers, as its registry `worker.modelList` recipe says.
// Run only by `doflow models --action sync` and the bind picker: never by a hook or a read verb. The
// process runs without a shell, bounded in time, and its whole process tree is ended on timeout
// (probeExec in src/install/tool-lifecycle.ts, the tool-status probe).

const { parserFor } = require('./parsers.ts');
const { validateValue } = require('../settings/files.ts');
import type { ListedModel, ParseTally } from './parsers.ts';

/** A listing may call the network (agy fetches its list), so it gets longer than a status probe. */
const LIST_TIMEOUT_MS = 20000;
/** The listing is another program's output: read at most this much of it (the process is ended past it), keep at most this many ids. */
const LIST_MAX_BYTES = 256 * 1024;
const LIST_MAX_MODELS = 500;

export type ModelListing =
  | { status: 'listed'; models: ListedModel[]; dropped: number; capped: boolean; columns?: string[]; columnFaults?: number }
  | { status: 'none-recorded'; models: ListedModel[]; reason: string }
  | { status: 'failed'; models: ListedModel[]; reason: string };

/** The listing for one worker descriptor (`harness.worker`). `execImpl(file, args, { timeout })` resolves
 * with stdout or rejects; the default is the tool probe. A failure (not installed, not logged in, offline,
 * timeout, no models in the output) is a `failed` result with a reason, never a throw. */
async function listHarnessModels({ descriptor, execImpl, timeoutMs = LIST_TIMEOUT_MS }: { descriptor: any; execImpl?: any; timeoutMs?: number }): Promise<ModelListing> {
  const recipe = descriptor?.modelList;
  if (!recipe) return { status: 'none-recorded', models: [], reason: 'the registry records no model listing command for this harness' };
  if (recipe.status !== 'supported') return { status: 'none-recorded', models: [], reason: String(recipe.reason || 'no model listing command is recorded') };
  const parse = parserFor(recipe, descriptor?.provider?.separator);
  const binary = descriptor?.cli?.binary;
  if (!parse || typeof binary !== 'string') return { status: 'failed', models: [], reason: `the registry modelList recipe is not usable (parse ${JSON.stringify(recipe.parse)})` };

  const run = execImpl || require('../../install/tool-lifecycle.ts').probeExec;
  let stdout: string;
  try {
    stdout = String(await run(binary, recipe.argv, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, maxBuffer: LIST_MAX_BYTES }) ?? '');
  } catch (error: any) {
    const why = error?.code === 'ENOENT' ? `${binary} is not installed`
      : error?.code === 'EMAXBUFFER' ? `more than ${LIST_MAX_BYTES / 1024} KiB of output; the command was stopped`
      : error?.code === 'ETIMEDOUT' ? `no answer within ${timeoutMs / 1000} s (a login prompt or a slow start can do this)`
        : `the command failed (${String(error?.message || error).split('\n')[0]})`;
    return { status: 'failed', models: [], reason: `${binary} ${recipe.argv.join(' ')}: ${why}` };
  }
  if (Buffer.byteLength(stdout, 'utf8') > LIST_MAX_BYTES) return { status: 'failed', models: [], reason: `${binary} ${recipe.argv.join(' ')}: more than ${LIST_MAX_BYTES / 1024} KiB of output` };
  // The ids go into settings and a launch argv, so an id the settings check would refuse (a leading dash, a control
  // character, whitespace, over 120 characters) is dropped here, and the count is shown.
  const tally: ParseTally = { columnFaults: 0 };
  const parsed: ListedModel[] = parse(stdout, tally);
  const usable = parsed.filter((model) => !/\s/.test(model.id) && !validateValue({ type: 'model-id' }, model.id));
  const models = usable.slice(0, LIST_MAX_MODELS);
  if (models.length === 0) return { status: 'failed', models: [], reason: `${binary} ${recipe.argv.join(' ')} printed no model ids that the ${recipe.parse} parser reads${parsed.length ? ` (${parsed.length} rejected as not model ids)` : ''}` };
  return {
    status: 'listed', models, dropped: parsed.length - usable.length, capped: usable.length > LIST_MAX_MODELS,
    ...(tally.columns ? { columns: tally.columns } : {}), ...(recipe.columns ? { columnFaults: tally.columnFaults } : {}),
  };
}

module.exports = { LIST_MAX_BYTES, LIST_MAX_MODELS, LIST_TIMEOUT_MS, listHarnessModels };
