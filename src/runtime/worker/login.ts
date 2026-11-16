'use strict';

/**
 * Login state from a declared recipe, `worker.loginProbe` (design 172 sections 4.1 to 4.4, IC-001). The runner,
 * `checkLogin`, runs the harness's own status command (and, with `providers`, its listing and one check per listed
 * provider) under fixed bounds and maps exit code and declared JSON paths to a state; stdout is never kept. The
 * answer precedence, `loginAnswerOf`, combines the stored recipe answer and the last run's outcome. The expiry
 * matcher, `loginExpiredOf`, finds a declared sign in a failed run's summary. Nothing here names a harness, reads a
 * credential file or a token variable: a package worker's recipe runs through the same code.
 */

const { spawnBounded } = require('./process-tree.ts');
const { compileTest, read } = require('./parsers/field-map.ts');
const { parserFor, cleanName } = require('../models/parsers.ts');
// The same cut quota.ts makes before matching its signals (quota.ts keeps its copy private).
const { cutBytes } = require('./parsers/common.ts');
const { descriptorDigest, workerCatalogue } = require('./catalogue.ts');
const { secretProblem, secretFlagsProblem } = require('../../registry/secret-flags.ts');
const { wideningProblem, wideningFlagsProblem } = require('../../registry/widening-flags.ts');
const { readLoginStore } = require('./login-store.ts');

type LoginState = 'logged-in' | 'logged-out' | 'expired' | 'unknown';
type Billing = { mode: 'subscription' | 'api-key'; billing: 'free' | 'metered' | 'unknown' };
type Test = { path: string[]; equals?: unknown; in?: unknown[]; is?: string };
type Answer = { exit: number; when?: Test[]; state: LoginState; reason?: string };
type ExpirySigns = { signs: string[]; basis: 'source' | 'transcript' | 'unverified'; evidence: string[] };

/** The recipe fields of a `supported` `loginProbe` (design 3.1, LD-1 `caveat`). The registry validates it. */
type LoginRecipe = {
  status: 'supported';
  argv: string[];
  output: 'json' | 'none';
  providers?: { argv: string[]; parse: string; emptyMeans: 'logged-out' | 'unknown'; max?: number };
  answers: Answer[];
  billing?: { path: string[]; values: Record<string, Billing> };
  expiry: 'seen' | 'not-seen';
  expirySigns?: ExpirySigns;
  hint?: string;
  caveat?: string;
};

type ProviderAnswer = { id: string; state: LoginState; mode: Billing['mode'] | null; reason: string | null };

/** What one run of a recipe found (design 4.1); stored by `recordRecipeAnswer` with the recipe's digest. */
type RecipeAnswer = {
  state: LoginState;
  reason: string | null;
  at: string;
  billing: Billing | 'mixed' | null;
  providers: ProviderAnswer[];
  checked: number;
  listed: number;
};

/** IC-001. */
type LoginAnswer = {
  harness: string;
  state: LoginState;
  reason: string | null;
  source: 'recipe' | 'last-run' | 'never-checked';
  at: string | null;
  billing: Billing | 'mixed' | null;
  providers: ProviderAnswer[];
  provider: string | null;
  hint: string | null;
  expirySeen: boolean;
  last: { state: LoginState; source: 'recipe' | 'last-run'; at: string } | null;
  caveat: string | null;
};

const PROCESS_MS = 3000;
const LISTING_MS = 5000;
const TOTAL_MS = 30000;
const MAX_STDOUT = 65536;
const MAX_PROVIDERS = 8;
const FRESH_MS = 24 * 60 * 60 * 1000;
const SLOT = '{provider}';
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_FIRST = /[A-Za-z0-9]/;
const PROVIDER_REST = /[A-Za-z0-9._-]/;
const PROVIDER_MAX = 64;
const SCAN_BYTES = 2000;
const ANSWER_BYTES = 1024;
const REASON_CHARS = 160;
const HINT_CHARS = 120;
const CAVEAT_CHARS = 160;
const NO_RECIPE_CHARS = 120;
const LIST_MAX = 32;

const iso = (ms: number) => new Date(ms).toISOString();
const clock = (now: any): (() => number) => (typeof now === 'function' ? now : () => (typeof now === 'number' ? now : Date.now()));
const plain = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cut = (text: unknown, max: number): string | null => (typeof text === 'string' ? Array.from(text).slice(0, max).join('') : null);
const supported = (worker: any) => worker?.loginProbe?.status === 'supported';

/** The digest a stored recipe answer is compared with: the descriptor digest helper on `worker.loginProbe`. */
function recipeDigest(worker: any): string {
  return descriptorDigest(worker?.loginProbe ?? null);
}

function unknown(reason: string, at: string, extra: Partial<RecipeAnswer> = {}): RecipeAnswer {
  return { state: 'unknown', reason, at, billing: null, providers: [], checked: 0, listed: 0, ...extra };
}

/** The first secret-printing or widening flag in a final argv, as an `unknown` reason, or null (the second line). */
function flagProblem(worker: any, argv: string[]): string | null {
  const binary = worker?.cli?.binary;
  const secrets = Array.isArray(worker?.secretFlags) && secretFlagsProblem(worker.secretFlags) === null ? worker.secretFlags : [];
  const widening = Array.isArray(worker?.wideningFlags) && wideningFlagsProblem(worker.wideningFlags) === null ? worker.wideningFlags : [];
  if (secretProblem(argv, { binary, declared: secrets })) return 'secret-flag';
  if (wideningProblem(argv, { binary, declared: widening })) return 'widening-flag';
  return null;
}

/** stdout as one JSON object, or null (not JSON, not an object, or cut at the stdout bound). */
function jsonObject(result: any): any {
  if (result.truncated) return null;
  try {
    const value = JSON.parse(String(result.stdout ?? ''));
    return plain(value) ? value : null;
  } catch {
    return null;
  }
}

/** One process's answer (design 4.1): bounds and signals first, then the first matching rule. */
function answerOf(recipe: LoginRecipe, result: any): { state: LoginState; reason: string | null; billing: Billing | null } {
  const none = (reason: string) => ({ state: 'unknown' as const, reason, billing: null });
  if (result.status === 'timeout') return none('timeout');
  if (result.status === 'error') return none(result.error === 'ENOENT' ? 'not-installed' : 'spawn-failed');
  if (!Number.isInteger(result.code)) return none(`signal ${result.signal ?? 'unknown'}`);
  let parsed: any;
  const json = () => (parsed === undefined ? (parsed = recipe.output === 'json' ? jsonObject(result) : null) : parsed);
  let neededJson = false;
  for (const rule of recipe.answers) {
    if (rule.exit !== result.code) continue;
    if (rule.when) {
      const event = json();
      if (event === null) { neededJson = true; continue; }
      if (!rule.when.every((test) => compileTest(test)(event))) continue;
    }
    let billing: Billing | null = null;
    if (rule.state === 'logged-in' && recipe.billing) {
      const event = json();
      const found = event === null ? null : read(event, recipe.billing.path);
      if (found?.present && typeof found.value === 'string' && Object.hasOwn(recipe.billing.values, found.value)) {
        const entry = recipe.billing.values[found.value];
        billing = { mode: entry.mode, billing: entry.billing };
      }
    }
    return { state: rule.state, reason: rule.reason ?? null, billing };
  }
  return none(neededJson ? 'unparseable-output' : `exit ${result.code}`);
}

/**
 * Whether a listing that gave no row parsed (an empty listing, where `emptyMeans` applies) rather than printed text no
 * parser reads (a usage line). A `table-column:<name>` listing parsed when a line's whitespace-separated cells name the
 * column (its header). `lines` and `tsv-first-column` have no header: they parsed with no row only when stdout holds no
 * text at all. Lines are compared after `cleanName`, so a header past its 120 characters is not seen (reads unparsed).
 */
function parsedEmpty(parse: string, text: string): boolean {
  const column = /^table-column:(.+)$/.exec(parse);
  if (!column) return cleanName(text) === '';
  return text.split(/\r\n|[\n\r\u2028\u2029]/).some((line) => cleanName(line).split(' ').includes(column[1]));
}

/** The harness answer from its providers' answers (design 4.3). */
function combine(answers: { provider: ProviderAnswer; billing: Billing | null }[], listed: number, at: string): RecipeAnswer {
  const providers = answers.map((entry) => entry.provider);
  const checked = providers.length;
  const all = checked === listed;
  const loggedIn = answers.filter((entry) => entry.provider.state === 'logged-in');
  let state: LoginState;
  let reason: string | null = null;
  if (loggedIn.length > 0) state = 'logged-in';
  else if (all && providers.every((entry) => entry.state === 'logged-out')) state = 'logged-out';
  else if (providers.some((entry) => entry.state === 'expired')) { state = 'expired'; reason = 'provider-expired'; }
  else {
    state = 'unknown';
    reason = providers.find((entry) => entry.state === 'unknown')?.reason ?? (listed > checked ? 'providers-partial' : 'unknown');
  }
  let billing: RecipeAnswer['billing'] = null;
  if (state === 'logged-in' && all) {
    const kinds = new Set(loggedIn.map((entry) => (entry.billing ? `${entry.billing.mode}/${entry.billing.billing}` : 'none')));
    if (kinds.size > 1) billing = 'mixed';
    else if (loggedIn[0].billing) billing = { ...loggedIn[0].billing };
  }
  return { state, reason, at, billing, providers, checked, listed };
}

/**
 * Runs a harness's declared login recipe (design 4.1, 4.3). Never throws for a process outcome: every failure is an
 * `unknown` answer with a reason. `now` is a number or a clock function; with a function, the 30 s whole-recipe bound
 * is measured on it too. `spawn` takes `spawnBounded`'s options and resolves its result (conform's and tests' seam).
 */
async function checkLogin({ harness, worker, env = process.env, cwd = process.cwd(), now = Date.now, binaryPath, spawn = spawnBounded, platform = process.platform }: any): Promise<RecipeAnswer> {
  void harness;
  const tick = clock(now);
  const started = tick();
  const stamp = () => iso(tick());
  if (!supported(worker)) return unknown('no-recipe', stamp());
  const recipe: LoginRecipe = worker.loginProbe;
  const binary = binaryPath ?? (worker?.cli?.binary ? require('./readiness.ts').findOnPath(worker.cli.binary, env, platform, cwd) : null);
  if (!binary) return unknown('not-installed', stamp());

  const left = () => TOTAL_MS - (tick() - started);
  const run = async (argv: string[], bound: number) => spawn({ binary, argv, cwd, env, timeoutMs: Math.max(1, Math.min(bound, left())), maxStdout: MAX_STDOUT });

  if (!recipe.providers) {
    const problem = flagProblem(worker, recipe.argv);
    if (problem) return unknown(problem, stamp());
    const one = answerOf(recipe, await run(recipe.argv, PROCESS_MS));
    return { state: one.state, reason: one.reason, at: stamp(), billing: one.state === 'logged-in' ? one.billing : null, providers: [], checked: 1, listed: 0 };
  }

  const listingProblem = flagProblem(worker, recipe.providers.argv);
  if (listingProblem) return unknown(listingProblem, stamp());
  const listing = await run(recipe.providers.argv, LISTING_MS);
  const parse = parserFor(recipe.providers);
  if (listing.status !== 'exited' || listing.code !== 0 || listing.truncated || !parse) return unknown('providers-unlisted', stamp());
  const text = String(listing.stdout ?? '');
  const ids: string[] = parse(text).map((model: any) => model.id);
  if (ids.length === 0 && !parsedEmpty(recipe.providers.parse, text)) return unknown('providers-unparsed', stamp());
  if (ids.length === 0) return { ...unknown('no-provider-listed', stamp()), state: recipe.providers.emptyMeans };

  const max = Number.isInteger(recipe.providers.max) ? Math.min(recipe.providers.max as number, MAX_PROVIDERS) : MAX_PROVIDERS;
  const answers: { provider: ProviderAnswer; billing: Billing | null }[] = [];
  for (const id of ids.filter((candidate) => PROVIDER_ID.test(candidate)).slice(0, max)) {
    if (left() <= 0) break; // the rest count as unchecked
    const argv = recipe.argv.map((item) => (item === SLOT ? id : item));
    const problem = flagProblem(worker, argv);
    const one = problem ? { state: 'unknown' as const, reason: problem, billing: null } : answerOf(recipe, await run(argv, PROCESS_MS));
    answers.push({ provider: { id, state: one.state, mode: one.state === 'logged-in' ? one.billing?.mode ?? null : null, reason: one.reason }, billing: one.billing });
  }
  return combine(answers, ids.length, stamp());
}

/** `text` with each character lower-cased only when that keeps its length, so indices match the original. */
function fold(text: string): string {
  return Array.from(text, (char) => { const lower = char.toLowerCase(); return lower.length === char.length ? lower : char; }).join('');
}

/** The provider characters at `from` in `text`: the longest run the slot allows, cut so `suffix` (folded) follows,
 * or, with no suffix, to its last letter or digit (a sentence's closing period is not part of an id). */
function providerAt(text: string, folded: string, from: number, suffix: string): string | null {
  if (!PROVIDER_FIRST.test(text[from] ?? '')) return null;
  let end = from + 1;
  while (end < text.length && end - from < PROVIDER_MAX && PROVIDER_REST.test(text[end])) end += 1;
  for (let stop = end; stop > from; stop -= 1) {
    if (suffix ? folded.startsWith(suffix, stop) : PROVIDER_FIRST.test(text[stop - 1])) return text.slice(from, stop);
  }
  return null;
}

/**
 * Design 4.4: the first declared expiry sign in a `failure` report's summary, as `{sign, provider}`, or null. Literal,
 * case-insensitive, on the summary's first 2,000 bytes; a `{provider}` slot captures `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
 * in its original case. No pattern is built from the data.
 */
function loginExpiredOf(report: any, worker: any): { sign: string; provider: string | null } | null {
  if (!report || report.status !== 'failure' || typeof report.summary !== 'string' || !report.summary) return null;
  const signs = worker?.loginProbe?.expirySigns?.signs;
  if (!Array.isArray(signs)) return null;
  const text = cutBytes(report.summary, SCAN_BYTES);
  const folded = fold(text);
  for (const sign of signs) {
    if (typeof sign !== 'string' || !sign) continue;
    const slot = sign.indexOf(SLOT);
    if (slot < 0) {
      if (folded.includes(fold(sign))) return { sign, provider: null };
      continue;
    }
    const prefix = fold(sign.slice(0, slot));
    const suffix = fold(sign.slice(slot + SLOT.length));
    for (let at = folded.indexOf(prefix); at >= 0; at = folded.indexOf(prefix, at + 1)) {
      const provider = providerAt(text, folded, at + prefix.length, suffix);
      if (provider) return { sign, provider };
    }
  }
  return null;
}

const ms = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);

/** IC-001's reason rule: null only for logged-in; a state with no reason of its own reads the state's name. */
function reasonFor(state: LoginState, reason: string | null): string | null {
  return cut(reason ?? (state === 'logged-in' ? null : state), REASON_CHARS);
}

/**
 * Holds the answer to 1 KiB of serialized UTF-8: provider reasons go first, then providers from the end, then the
 * caveat, the hint and the reason are cut one character at a time from their end, in that order (an emptied one is
 * null). The reason is cut only once caveat and hint are gone, which takes text at its own limits into the bound.
 */
function bounded(answer: LoginAnswer): LoginAnswer {
  const size = () => Buffer.byteLength(JSON.stringify(answer));
  if (size() <= ANSWER_BYTES) return answer;
  answer.providers = answer.providers.map((entry) => ({ ...entry, reason: null }));
  while (size() > ANSWER_BYTES && answer.providers.length > 0) answer.providers.pop();
  for (const key of ['caveat', 'hint', 'reason'] as const) {
    const chars = Array.from(answer[key] ?? '');
    while (size() > ANSWER_BYTES && chars.length > 0) {
      chars.pop();
      answer[key] = chars.length > 0 ? chars.join('') : null;
    }
  }
  return answer;
}

/**
 * IC-001, design 4.2: the answer for one harness from its store slot `record` (`{recipe, run}` or null). Pure.
 * 1 a harness with no recipe and no run outcome reads `never-checked`, `no-recipe: <reason>`; 2 a run's `expired`
 * stands until a later `succeeded` run or a later `logged-in` answer of a current recipe that can see expiry (O-3);
 * 3 else the newer of the recipe answer and a `succeeded` run, `stale` past 24 h or on another recipe digest;
 * 4 else `never-checked`.
 */
function loginAnswerOf({ harness, worker, record, now = Date.now }: any): LoginAnswer {
  const nowMs = clock(now)();
  const probe = worker?.loginProbe ?? {};
  const recipeOk = supported(worker);
  const base = (fields: Partial<LoginAnswer>): LoginAnswer => {
    const state = fields.state ?? 'unknown';
    // A stale answer says where and when its last answer came from.
    return bounded({
      harness,
      state,
      reason: reasonFor(state, fields.reason ?? null),
      source: fields.source ?? fields.last?.source ?? 'never-checked',
      at: fields.at ?? fields.last?.at ?? null,
      billing: fields.billing ?? null,
      providers: (fields.providers ?? []).slice(0, MAX_PROVIDERS).map((entry) => ({ ...entry })),
      provider: fields.provider ?? null,
      hint: cut(probe.hint, HINT_CHARS),
      expirySeen: recipeOk && probe.expiry === 'seen',
      last: fields.last ?? null,
      caveat: recipeOk && (fields.source === 'recipe' || fields.last?.source === 'recipe') ? cut(probe.caveat, CAVEAT_CHARS) : null,
    });
  };
  const recipe = plain(record?.recipe) ? record.recipe : null;
  const run = plain(record?.run) ? record.run : null;

  if (!recipeOk && !run) {
    const why = cut(probe.reason, NO_RECIPE_CHARS);
    return base({ reason: why ? `no-recipe: ${why}` : 'no-recipe' });
  }

  const digest = recipeDigest(worker);
  if (run?.outcome === 'expired') {
    const cleared = recipe && recipeOk && probe.expiry === 'seen' && recipe.state === 'logged-in'
      && recipe.digest === digest && ms(recipe.at) > ms(run.at);
    if (!cleared) return base({ state: 'expired', source: 'last-run', at: run.at, provider: run.provider ?? null });
  }

  const succeeded = run?.outcome === 'succeeded' ? run : null;
  if (succeeded && (!recipe || ms(succeeded.at) >= ms(recipe.at))) {
    if (!(nowMs - ms(succeeded.at) <= FRESH_MS)) return base({ reason: 'stale', last: { state: 'logged-in', source: 'last-run', at: succeeded.at } });
    return base({ state: 'logged-in', source: 'last-run', at: succeeded.at });
  }
  if (recipe) {
    if (recipe.digest !== digest || !(nowMs - ms(recipe.at) <= FRESH_MS)) {
      return base({ reason: 'stale', last: { state: recipe.state, source: 'recipe', at: recipe.at } });
    }
    return base({ state: recipe.state, reason: recipe.reason, source: 'recipe', at: recipe.at, billing: recipe.billing, providers: recipe.providers });
  }
  return base({ reason: 'never-checked' });
}

/**
 * IC-002's list: one answer per worker, in worker-catalogue order, at most 32, read from the store. Starts no
 * process. `workers` (`[{id, worker}]`) replaces the catalogue for a caller that already holds it.
 */
function loginAnswers({ env = process.env, now = Date.now, registry, view, workers }: any = {}): LoginAnswer[] {
  const list = workers ?? workerCatalogue({ registry, view });
  const store = readLoginStore(env);
  return list.slice(0, LIST_MAX).map((entry: any) => loginAnswerOf({ harness: entry.id, worker: entry.worker, record: store.harnesses[entry.id] ?? null, now }));
}

/** Design 4.6: the readiness `login` fact of an answer. */
function loginFact(answer: LoginAnswer, basis = 'free') {
  const fact = (state: string, reason: string | null) => ({ state, reason, at: answer.at, basis });
  if (answer.state === 'logged-in') return fact('yes', 'logged-in');
  if (answer.state === 'logged-out') return fact('no', 'logged-out');
  if (answer.state === 'expired') return fact('no', `login-expired ${answer.provider ?? answer.harness}`);
  return fact('unknown', answer.reason);
}

/**
 * Design 7.2's doctor `login:` cell for one answer, with LD-1's caveat inside the brackets of a recipe-sourced answer:
 * `logged-in (login check, <at>; <caveat>)`, `expired (run, <at>) provider <p> (re-login: <hint>)`, `unknown (never
 * checked)`, `unknown (no login check: <reason>)`, `unknown (stale; last <state> <at>)`, `unknown (<reason>, <at>)`.
 */
function loginCell(answer: LoginAnswer): string {
  const caveat = answer.caveat ? `; ${answer.caveat}` : '';
  const relogin = answer.hint ? ` (re-login: ${answer.hint})` : '';
  const how = `${answer.source === 'recipe' ? 'login check' : 'run'}, ${answer.at}${caveat}`;
  if (answer.state === 'logged-in') return `logged-in (${how})`;
  if (answer.state === 'logged-out') return `logged-out (${how})${relogin}`;
  if (answer.state === 'expired') return `expired (${how})${answer.provider ? ` provider ${answer.provider}` : ''}${relogin}`;
  const reason = answer.reason ?? 'unknown';
  if (reason === 'never-checked') return 'unknown (never checked)';
  if (reason === 'no-recipe' || reason.startsWith('no-recipe: ')) {
    return `unknown (no login check${reason === 'no-recipe' ? '' : `: ${reason.slice('no-recipe: '.length)}`})`;
  }
  if (reason === 'stale' && answer.last) return `unknown (stale; last ${answer.last.state} ${answer.last.at}${caveat})`;
  return `unknown (${reason}${answer.at ? `, ${answer.at}` : ''}${caveat})`;
}

module.exports = { checkLogin, loginAnswerOf, loginAnswers, loginExpiredOf, loginFact, loginCell, recipeDigest, PROCESS_MS, LISTING_MS, TOTAL_MS, ANSWER_BYTES };

export type { LoginRecipe, RecipeAnswer, LoginAnswer, LoginState, ProviderAnswer };
