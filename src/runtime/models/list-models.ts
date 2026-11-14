'use strict';

// Asks a harness's own CLI which model ids it offers, as its registry `worker.modelList` recipe says.
// Run only by `doflow models --action sync` and the bind picker: never by a hook or a read verb. The
// process runs without a shell, bounded in time, and its whole process tree is ended on timeout
// (probeExec in src/install/tool-lifecycle.ts, the tool-status probe).

const { parserFor } = require('./parsers.ts');
import type { ListedModel } from './parsers.ts';

/** A listing may call the network (agy fetches its list), so it gets longer than a status probe. */
const LIST_TIMEOUT_MS = 20000;

export type ModelListing =
  | { status: 'listed'; models: ListedModel[] }
  | { status: 'none-recorded'; models: ListedModel[]; reason: string }
  | { status: 'failed'; models: ListedModel[]; reason: string };

/** The listing for one worker descriptor (`harness.worker`). `execImpl(file, args, { timeout })` resolves
 * with stdout or rejects; the default is the tool probe. A failure (not installed, not logged in, offline,
 * timeout, no models in the output) is a `failed` result with a reason, never a throw. */
async function listHarnessModels({ descriptor, execImpl, timeoutMs = LIST_TIMEOUT_MS }: { descriptor: any; execImpl?: any; timeoutMs?: number }): Promise<ModelListing> {
  const recipe = descriptor?.modelList;
  if (!recipe) return { status: 'none-recorded', models: [], reason: 'the registry records no model listing command for this harness' };
  if (recipe.status !== 'supported') return { status: 'none-recorded', models: [], reason: String(recipe.reason || 'no model listing command is recorded') };
  const parse = parserFor(recipe.parse);
  const binary = descriptor?.cli?.binary;
  if (!parse || typeof binary !== 'string') return { status: 'failed', models: [], reason: `the registry modelList recipe is not usable (parse ${JSON.stringify(recipe.parse)})` };

  const run = execImpl || require('../../install/tool-lifecycle.ts').probeExec;
  let stdout: string;
  try {
    stdout = await run(binary, recipe.argv, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
  } catch (error: any) {
    const why = error?.code === 'ENOENT' ? `${binary} is not installed`
      : error?.code === 'ETIMEDOUT' ? `no answer within ${timeoutMs / 1000} s (a login prompt or a slow start can do this)`
        : `the command failed (${String(error?.message || error).split('\n')[0]})`;
    return { status: 'failed', models: [], reason: `${binary} ${recipe.argv.join(' ')}: ${why}` };
  }
  const models = parse(String(stdout ?? ''));
  if (models.length === 0) return { status: 'failed', models: [], reason: `${binary} ${recipe.argv.join(' ')} printed no model ids that the ${recipe.parse} parser reads` };
  return { status: 'listed', models };
}

module.exports = { LIST_TIMEOUT_MS, listHarnessModels };
