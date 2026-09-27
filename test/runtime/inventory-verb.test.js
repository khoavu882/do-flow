'use strict';

/**
 * C7 — the `inventory` verb, end to end (feature 041, task D.3; IC-001, IC-002, FR-006).
 *
 * The five modules beneath `src/runtime/inventory/index.js` are each unit-tested beside
 * themselves. Three things are true only of the assembled verb, and are tested here because no
 * unit test can reach them:
 *
 *   1. **The verb stays wired.** IC-001 puts the verb on the runtime seam, which means four
 *      places agree: the dispatcher's Node arm, the dispatcher's `usage()`, the CLI's command
 *      switch, and the verb-reachability allowlist. `test/guards/runtime-unification.test.js`
 *      holds the *rule* (no command off the seam, no verb without a command) and
 *      `test/guards/verb-reachability.test.js` holds the *allowlist discipline* — but neither
 *      notices a verb deleted from every table at once, because both are satisfied by a verb that
 *      does not exist. This file pins the membership those rules are silent about.
 *   2. **`repairPath` means one thing.** See the block comment above the second section.
 *   3. **The join actually joins.** Every cross-scope assertion until now has been made against a
 *      machine with no project-scope install, so the report has only ever produced single-copy
 *      logical assets. The last section drives the assembler with two seeded scopes holding one
 *      logical asset between them and asserts the shape IC-002 promises: one entry, one record
 *      per scope, and a verdict naming the winner.
 *
 * Hermetic throughout. Scope roots are `mkdtemp` directories; the global scope's root is not a
 * parameter (design R7), so `os.homedir` is relocated around the synchronous call, as
 * `test/lifecycle/dual-scope-read.test.js` does. Nothing is written inside the repository or
 * inside the real `$HOME`, and no install is performed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { stateRoot, defaultLedger, writeLedger } = require('../../src/state');
const { defaultLock } = require('../../src/state/lockfile');
const { loadRegistry } = require('../../src/registry');
const { readScopes } = require('../../src/runtime/inventory/read-scopes');
const { buildInventoryReport, printReport, FINDING_KINDS, RECONCILE, MANUAL } = require('../../src/runtime/inventory');
const { REPAIR_REASONS } = require('../../src/runtime/inventory/coverage');

const REPO = path.resolve(__dirname, '../..');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

// --------------------------------------------------------------------- 1. the verb stays wired

test('IC-001: the inventory verb is present in all four places the seam requires', () => {
  const dispatcher = fs.readFileSync(DISPATCHER, 'utf8');

  const nodeArm = dispatcher.match(/is_node_verb\(\)\s*\{([\s\S]*?)\r?\n\}/);
  assert.ok(nodeArm, 'is_node_verb() must be parseable in doflow-run');
  assert.match(nodeArm[1].replace(/\\\r?\n/g, ''), /\binventory\b/,
    'inventory is a Node-backed verb and must appear in the dispatcher\'s node arm; without it the '
    + 'dispatcher answers "unknown verb" and the CLI command is reachable only by going around the seam');

  const usage = dispatcher.match(/usage\(\)\s*\{\s*cat <<'EOF'\r?\n([\s\S]*?)\r?\nEOF/);
  assert.ok(usage, 'usage() must be parseable in doflow-run');
  assert.match(usage[1], /^ {2}inventory\s{2,}\S/m,
    'usage() is the only verb list a user ever sees; an undocumented verb is an unreachable one');

  const cli = fs.readFileSync(path.join(REPO, 'src', 'cli', 'runtime-commands.js'), 'utf8');
  assert.match(cli, /case 'inventory': return handleInventoryCommand/,
    "the command must stay in the single-expression case form: written as a block it becomes "
    + 'invisible to G8 and G12, which then go quiet rather than red');

  // The allowlist entry, and the reason with it. G17 checks that every allowlisted verb exists and
  // carries a rationale; it cannot check that THIS verb is still declared, because a verb with no
  // allowlist entry and no skill caller is simply a G17 failure — a legible one, but only if the
  // verb still exists. This asserts the recorded decision itself.
  const reachability = fs.readFileSync(path.join(REPO, 'test', 'guards', 'verb-reachability.test.js'), 'utf8');
  const entry = reachability.match(/\[\s*'inventory',\s*\r?\n\s*'([^']+)'/);
  assert.ok(entry, 'inventory must carry an entry in verb-reachability.test.js\'s ALLOWLIST: no skill '
    + 'calls it and none should, so its caller-free state is a decision that has to be recorded rather '
    + 'than a gap');
  assert.ok(entry[1].length > 40, 'the allowlist rationale must state why the verb is caller-free');
});

// ------------------------------------------------------------ 2. what repairPath means, settled

/**
 * **Decision (task D.3, settling the D.1 finding): a finding outside the reconcile path declares
 * `repairPath: 'manual'`. Absence is reserved for a finding that names no remedy at all.**
 *
 * C.3 introduced the field with absence meaning unrepairable; D.1 set `'manual'` and asked to be
 * overruled if this task's guard expected absence. It does not, and FR-006 is why. FR-006 forbids
 * *over-claiming* a remedy, and the two spellings are identical on that measure — `coverage.js`
 * counts a finding repairable only when its `repairPath` is exactly `'reconcile'`, so `'manual'`
 * and absence both score unrepairable and neither moves the coverage counts by one. What differs
 * is the reason attached: absence classifies as `repair-path-unstated`, whose own definition in
 * `coverage.js` is "the finding names no remedy at all", and that is false of a shadow, a withheld
 * verdict and an unmanaged sibling — each one carries a literal action on its asset entry.
 * Declaring `'manual'` therefore under-claims nothing and stops the report from making a false
 * statement about itself. Absence stays meaningful, for a finding that genuinely states no remedy.
 *
 * The two assertions that make this a decision rather than a preference: every finding the
 * assembler emits carries a non-empty `repairPath`, and every `'manual'` one is backed by a real
 * remedy action on its asset. The second is what makes the label truthful — if a finding kind ever
 * declares `'manual'` while naming no action, `repair-path-unstated` would have been the honest
 * classification and this test fails.
 */
test('FR-006: divergence declares reconcile, every other finding declares manual, and manual is backed by an action', () => {
  const { report } = fixtureReport();

  const unstated = report.findings.filter((finding) => typeof finding.repairPath !== 'string' || finding.repairPath === '');
  assert.deepEqual(unstated, [],
    'every finding the report emits states a repair path. Absence is reserved for a finding naming '
    + 'no remedy at all, and this report has no such kind');

  for (const finding of report.findings) {
    const expected = finding.kind === FINDING_KINDS.DIVERGENCE ? RECONCILE : MANUAL;
    assert.equal(finding.repairPath, expected,
      `a ${finding.kind} finding must declare '${expected}': reconcile converges a scope onto its own `
      + 'pin and does nothing else — it does not delete a rival copy at the other scope, cannot '
      + 'establish an undocumented precedence, and never touches a file DoFlow did not install');
  }

  // Every 'manual' finding names a literal action on its asset, which is what makes the label
  // 'outside-repair-path' true rather than 'repair-path-unstated'.
  const byIdentity = new Map(report.assets.map((asset) => [asset.identity, asset]));
  const unbacked = report.findings
    .filter((finding) => finding.repairPath === MANUAL)
    .filter((finding) => !(byIdentity.get(finding.id)?.remedy?.actions ?? []).some((action) => action.finding === finding.kind))
    .map((finding) => `${finding.kind} on ${finding.id}`);
  assert.deepEqual(unbacked, [],
    "these findings declare repairPath 'manual' but name no action on their asset entry, so the "
    + 'report claims a manual remedy it never states. Either state the action, or let the field be '
    + `absent so coverage classifies them repair-path-unstated honestly:\n  ${unbacked.join('\n  ')}`);
});

test('FR-006: a manual finding is counted unrepairable for being outside the repair path, never for being unstated', () => {
  const { report } = fixtureReport();
  const detailsByKind = new Map(report.findings.map((finding, index) => [finding.kind, report.repairCoverage.details[index]]));

  const shadow = detailsByKind.get(FINDING_KINDS.SHADOW);
  assert.ok(shadow, 'the fixture must produce a shadow finding for this assertion to mean anything');
  assert.equal(shadow.repairable, false, 'no manual finding may ever be counted repairable (FR-006)');
  assert.equal(shadow.reason, REPAIR_REASONS.OUTSIDE_REPAIR_PATH,
    "a shadow states a remedy that `doflow reconcile` cannot perform, which is 'outside-repair-path'. "
    + "'repair-path-unstated' would say the finding names no remedy at all, and it does name one");

  const divergence = detailsByKind.get(FINDING_KINDS.DIVERGENCE);
  assert.ok(divergence, 'the fixture must produce a divergence finding');
  assert.equal(divergence.repairable, true,
    'the fixture pins claude at project scope, so its divergence is the one finding reconcile can act on');

  assert.equal(report.repairCoverage.reasons[REPAIR_REASONS.REPAIR_PATH_UNSTATED], undefined,
    'no finding in this report leaves its repair path unstated, so that reason must not appear at all');
});

// ------------------------------------------------------------------- 3. the join, end to end

test('IC-002: one logical asset held at both scopes joins into one entry with a record per scope', () => {
  const { report, roots, joined } = fixtureReport();

  const entry = report.assets.find((asset) => asset.identity === joined.identity);
  assert.ok(entry, `the seeded asset ${joined.identity} must appear in the report`);
  assert.equal(
    report.assets.filter((asset) => asset.identity === joined.identity).length, 1,
    'two copies of one logical asset are ONE entry; a second entry means the join key stopped joining'
  );
  assert.equal(report.unidentified.length, 0,
    'both seeded resources record a harness and an ownership identity, so neither may land in the '
    + 'unidentified list');

  assert.equal(entry.harness, 'claude');
  assert.deepEqual(entry.copies.map((copy) => copy.scope).sort(), ['global', 'project'],
    'IC-002 requires one record per scope at which a copy exists — here, both');
  assert.deepEqual(
    Object.fromEntries(entry.copies.map((copy) => [copy.scope, copy.location])),
    { global: joined.globalTarget, project: joined.projectTarget },
    'each per-scope record states that copy\'s own location, not the other\'s'
  );
  for (const copy of entry.copies) {
    assert.equal(copy.currency, 'matches',
      'the seeded copies are at paths no plan touches and both record a fingerprint, so neither has '
      + 'diverged and neither is indeterminable');
  }

  // claude records order ["user","project"] with mode first-wins, so the global copy is the one
  // the harness loads and the project copy is shadowed. The verdict names the winner in the
  // report's own scope vocabulary, never the registry's.
  assert.equal(entry.verdict.shadowed, true);
  assert.equal(entry.verdict.winner, 'global');
  assert.equal(entry.verdict.withheldReason, null);
  assert.deepEqual(entry.verdict.presentAt.sort(), ['global', 'project']);

  const shadowAction = entry.remedy.actions.find((action) => action.finding === FINDING_KINDS.SHADOW);
  assert.ok(shadowAction, 'a shadowed asset must carry the literal action that resolves it');
  assert.match(shadowAction.action, /global/, 'the remedy names the copy the harness actually loads');
  assert.match(shadowAction.action, new RegExp(joined.projectTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the remedy names the outranked copy by its own path, so it can be performed directly');

  // Both scopes are reported as read and present, with their own roots (IC-002's first field).
  assert.deepEqual(
    report.scopes.map((scope) => [scope.scope, scope.root, scope.present]),
    [['global', roots.home, true], ['project', roots.project, true]]
  );
  assert.equal(report.status, 'FINDINGS');
  assert.equal(report.exitCode, 1, 'a shadowed asset is a finding the caller must act on (IC-001)');
});

// ------------------------------------------------------------------------------- the fixture

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** The human rendering, captured. Asserted beside the JSON wherever a report's two renderings could
 * disagree — which is not hypothetical here: `printReport` skips every asset whose remedy is null,
 * so an asset that gained a finding without gaining a remedy would be invisible in this half only. */
function render(report) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { printReport(report); } finally { console.log = original; }
  return lines.join('\n');
}

function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The global scope root is derived from the process home directory and is not injectable
 * (design R7), so a hermetic global-scope read relocates it around the synchronous call. */
function withHomeDir(dir, fn) {
  const original = os.homedir;
  os.homedir = () => dir;
  try { return fn(); } finally { os.homedir = original; }
}

function resource({ scope, assetId, ownershipIdentity, target, fingerprint }) {
  return {
    harness: 'claude', scope, assetId, ownershipIdentity, target,
    sourceVersion: 'test', fingerprint, projection: {}, recoveryRef: null, selection: null,
  };
}

function seedScope({ scope, scopeRoot, resources, harness = 'claude' }) {
  const ledger = defaultLedger({ scope, scopeRoot });
  ledger.targets[harness] = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push(...resources);
  writeLedger(stateRoot({ scope, projectRoot: scopeRoot, homeDir: scopeRoot }), ledger);
}

/**
 * Two synthetic scope snapshots, seeded as ledgers so the report is assembled through the real
 * reader rather than around it, holding:
 *
 *   - one logical asset with a copy at each scope, at a path no plan produces, so both copies
 *     read `matches` and the only finding it raises is the shadow the join exists to find;
 *   - one project-scope-only copy whose key the claude plan does produce, so it reads `diverged`
 *     and contributes the one finding `doflow reconcile` can act on.
 *
 * The project scope is pinned for claude and the global scope is unpinned, which is what lets the
 * repair-coverage assertions tell `outside-repair-path` apart from a narrow lock.
 */
function fixtureReport() {
  const home = scratch('doflow-inventory-home-');
  const project = scratch('doflow-inventory-project-');

  const joined = {
    identity: 'claude doflow:claude:copy-tree:skills.doflow:synthetic-041/SKILL.md',
    ownershipIdentity: 'doflow:claude:copy-tree:skills.doflow:synthetic-041/SKILL.md',
    globalTarget: path.join(home, '.claude', 'skills', 'synthetic-041', 'SKILL.md'),
    projectTarget: path.join(project, '.claude', 'skills', 'synthetic-041', 'SKILL.md'),
  };
  // The key the claude plan really emits for this source file at project scope, so the currency
  // judgement resolves to `diverged` against a live plan rather than a hand-set flag.
  const diverged = {
    assetId: 'skills.doflow',
    ownershipIdentity: 'doflow:claude:copy-tree:skills.doflow:do/SKILL.md',
    target: path.join(project, '.claude', 'skills', 'do', 'SKILL.md'),
  };

  seedScope({
    scope: 'global',
    scopeRoot: home,
    resources: [resource({
      scope: 'global', assetId: 'skills.doflow', ownershipIdentity: joined.ownershipIdentity,
      target: joined.globalTarget, fingerprint: 'sha256:0000000000000000',
    })],
  });
  seedScope({
    scope: 'project',
    scopeRoot: project,
    resources: [
      resource({
        scope: 'project', assetId: 'skills.doflow', ownershipIdentity: joined.ownershipIdentity,
        target: joined.projectTarget, fingerprint: 'sha256:0000000000000000',
      }),
      resource({
        scope: 'project', assetId: diverged.assetId, ownershipIdentity: diverged.ownershipIdentity,
        target: diverged.target, fingerprint: 'sha256:1111111111111111',
      }),
    ],
  });

  const report = withHomeDir(home, () => buildInventoryReport({
    repoRoot: REPO,
    projectRoot: project,
    targets: ['claude'],
    locks: { global: null, project: { targets: [{ harness: 'claude' }] } },
  }));

  return { report, roots: { home, project }, joined, diverged };
}

// ------------------------------------------- 4. the restriction, and what silence about a resource means

/**
 * IC-001 makes `targets` a restriction to named harnesses. It used to restrict the *plan* and not the
 * *reported set*: every resource of every installed harness came back beside a plan computed for the
 * named ones only, and since currency was derived from absence-from-that-plan, every unnamed
 * harness's copy was positively asserted current. On a machine with a real install, naming a harness
 * the user does not have produced 989 `matches`, no findings, and exit 0 — an "all clear" obtainable
 * by asking about something that is not there.
 *
 * The fixture holds one drifted copy per harness, so the two halves are one fixture: what a
 * restriction must report, and what it must not claim.
 */
test('IC-001: a restriction reports only the named harness and claims nothing about the others', () => {
  const fixture = restrictionFixture();

  const both = fixture.report();
  assert.deepEqual(
    both.assets.map((asset) => asset.harness).sort(), ['claude', 'gemini'],
    'unrestricted, both seeded copies are reported — if this fails the seeded paths no longer match '
    + 'the plan\'s own keys and the assertions below would pass for the wrong reason'
  );
  assert.equal(both.findings.length, 2, 'both seeded copies are divergences against the live plan');

  const claudeOnly = fixture.report(['claude']);
  assert.deepEqual(claudeOnly.assets.map((asset) => asset.harness), ['claude'],
    'a restricted report contains only the named harness');
  assert.deepEqual(
    claudeOnly.assets.flatMap((asset) => asset.copies).filter((copy) => copy.currency === 'matches'), [],
    'nothing may be reported as current here: the only copy in view is the drifted claude one, and the '
    + 'gemini copy — which the claude plan never evaluated — must be absent rather than asserted current'
  );
  assert.equal(claudeOnly.unidentified.length, 0);
  assert.deepEqual(claudeOnly.scopes.map((scope) => scope.resources), [1, 0],
    'the per-scope resource count follows the restriction too');
  assert.match(claudeOnly.summary, /recorded for claude/,
    'the summary a reader meets first must name the restriction, or "nothing requires attention" from a '
    + 'one-harness run reads as a statement about the install');
});

test('IC-001: a restriction naming an installed-but-drifted harness still exits 1', () => {
  const fixture = restrictionFixture();

  const geminiOnly = fixture.report(['gemini']);

  assert.equal(geminiOnly.status, 'FINDINGS');
  assert.equal(geminiOnly.exitCode, 1, 'the named harness has a divergence, so this is exit 1 (IC-001)');
  assert.deepEqual(geminiOnly.findings.map((finding) => [finding.kind, finding.harness]),
    [[FINDING_KINDS.DIVERGENCE, 'gemini']]);
  assert.deepEqual(geminiOnly.assets.flatMap((asset) => asset.copies).map((copy) => copy.currency), ['diverged'],
    'the one copy in view is the drifted one; no copy of any other harness is present to be called current');
});

// ------------------------------------------------ 5. a planned removal is not a divergence (FR-006)

/**
 * Currency is read from the scope's plan, and a plan change carries an operation. A change that would
 * *delete* a resource says nothing about whether its content is current, so it is not a divergence —
 * and reporting it as one is the worst kind of finding this verb can emit, because the remedy it
 * attaches promises to "restore ... to what the current source produces" while the plan behind it
 * says remove. Following that remedy would delete a working registration; FR-006 forbids exactly this.
 *
 * The fixture is the case that actually occurred: a Codex MCP server, registered and recorded, whose
 * scope records no selection for it. `test/runtime/inventory-read-scopes.test.js` pins that this
 * fixture really does produce a `remove`; this test pins what the report may say about one.
 *
 * **Task H.1 revised the second half of this test.** It used to assert no finding, no remedy and exit
 * 0, on the reasoning that a copy the plan would delete is nothing to act on. That confused two
 * statements: that the report may not claim a *divergence* here, which stands, with a claim that the
 * install is *sound* here, which IC-001 grants only where every asset resolves to a copy that matches
 * what the current source would produce. This one resolves to no comparison at all. So the copy is a
 * finding of its own kind, `unjudged-copy`, and the assertions below are what FR-006 actually forbids:
 * the remedy may not say "restore", and it must say what would let the copy be judged instead.
 */
test('FR-006: a copy the plan would remove is not a divergence, and its remedy never says restore', () => {
  const report = mcpReport({ mcpSelections: {} });

  const [asset] = report.assets;
  assert.ok(asset, 'the recorded MCP server must be reported as a logical asset');
  const [copy] = asset.copies;
  assert.equal(copy.currency, 'indeterminable',
    'a copy the plan would delete rather than rewrite cannot be judged current and has not diverged. '
    + 'IC-002 allows exactly three values and this is the third, not a softened second');
  assert.match(copy.currencyReason, /remove this copy rather than rewrite it/,
    'the reason must name the removal, so this value cannot be confused with the other two paths to '
    + 'indeterminable (no fingerprint, no plan for the harness)');
  assert.deepEqual(asset.remedy.actions.map((action) => action.finding), [FINDING_KINDS.UNJUDGED_COPY],
    'the entry carries exactly one action, and it is the unjudged-copy one — no divergence action, which '
    + 'is what would promise to "restore" a copy the plan behind that remedy would delete');
  assert.doesNotMatch(asset.remedy.actions[0].action, /restore/,
    'the remedy for a copy nobody judged may not say restore: nothing here knows what the copy should '
    + 'contain, which is the whole of what makes it unjudged (FR-006)');
  assert.match(asset.remedy.actions[0].action, /planned removal run/,
    'it states what would give a later run a basis instead — settle whether this scope wants the copy '
    + 'here — which is the only honest action available');
  assert.equal(asset.remedy.actions[0].command, null, 'and names no command, because none performs it');

  assert.deepEqual(report.findings.map((finding) => [finding.kind, finding.harness, finding.scope, finding.repairPath]),
    [[FINDING_KINDS.UNJUDGED_COPY, 'codex', 'global', MANUAL]],
    'one finding, and not a divergence: the content is not stated to differ. Its scope is the one holding '
    + 'the copy — unlike a withheld verdict, an unjudged copy has a determinate scope, and the missing '
    + 'basis (this scope\'s plan and its selection) belongs to it');
  assert.equal(report.exitCode, 1,
    'and the verb does not answer exit 0 when the only thing it found is the thing it could not judge');
  assert.equal(report.repairCoverage.findings, 1,
    'the FR-006 denominator grows by one — a finding a reader must act on is one coverage has to account '
    + 'for, and hiding it from the denominator is how coverage comes to read as completeness');
  assert.equal(report.repairCoverage.repairable, 0,
    'while the numerator does not: `doflow reconcile` cannot supply the basis for a judgement');
  assert.equal(report.repairCoverage.details[0].reason, REPAIR_REASONS.OUTSIDE_REPAIR_PATH,
    'and the reason is that the stated remedy is outside the repair path, not that none was stated');

  // The asset must be visible in the rendering a human reads, which is where it was missing entirely:
  // `printReport` skips every asset whose remedy is null, so a finding without a remedy would print
  // "nothing requires attention" over a list containing nothing.
  const rendered = render(report);
  assert.match(rendered, new RegExp(escapeRe(copy.location)), 'the unjudged copy must reach the human rendering');
  assert.match(rendered, /remove this copy rather than rewrite it/,
    'with the reason it could not be judged, since the four paths to indeterminable call for four '
    + 'different actions and the value alone does not say which this is');
  assert.doesNotMatch(rendered, /restore/, 'and no half of the report offers to restore it');
});

test('FR-006: the same copy, with its selection recorded in the lock, is reported as current', () => {
  const report = mcpReport({ mcpSelections: { codex: ['context7'] } });

  const [copy] = report.assets[0].copies;
  assert.equal(copy.currency, 'matches',
    'with the scope\'s own selection fed to the plan there is no change for this resource at all, so '
    + 'it is current — which is what it always was. Defaulting the selection to none is what made a '
    + 'correctly installed server look broken');
  assert.equal(copy.currencyReason, null);
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, 'CLEAN');
  assert.equal(report.exitCode, 0,
    'the control for the test above and for task H.1 generally: a report whose every copy was compared '
    + 'and found current still exits 0. Making an unjudged copy a finding must not make everything one');
  assert.doesNotMatch(render(report), /remedy/,
    'and the human rendering names no remedy, because there is nothing to act on');
});

// ------------------------------------------------------------------------- the further fixtures

/** One drifted copy per harness at global scope, with the ownership identity and destination the
 * live plan really emits for that source file, so `diverged` is a judgement against a real plan
 * rather than a hand-set flag. */
function restrictionFixture() {
  const home = scratch('doflow-inventory-restrict-home-');
  const project = scratch('doflow-inventory-restrict-project-');
  const rows = [
    {
      harness: 'claude', ownershipIdentity: 'doflow:claude:copy-tree:skills.doflow:do/SKILL.md',
      target: path.join(home, '.claude', 'skills', 'do', 'SKILL.md'),
    },
    {
      harness: 'gemini', ownershipIdentity: 'doflow:gemini:copy-tree:skills.doflow:do/SKILL.md',
      target: path.join(home, '.gemini', 'config', 'skills', 'do', 'SKILL.md'),
    },
  ];

  const ledger = defaultLedger({ scope: 'global', scopeRoot: home });
  for (const row of rows) {
    ledger.targets[row.harness] = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
    ledger.resources.push({
      ...row, scope: 'global', assetId: 'skills.doflow', sourceVersion: 'test',
      fingerprint: 'sha256:0000000000000000', projection: {}, recoveryRef: null, selection: null,
    });
  }
  writeLedger(stateRoot({ scope: 'global', projectRoot: home, homeDir: home }), ledger);

  return {
    rows,
    report: (targets) => withHomeDir(home, () => buildInventoryReport({
      repoRoot: REPO, projectRoot: project, ...(targets ? { targets } : {}),
      locks: { global: null, project: null },
    })),
  };
}

/** A global scope holding one registered, DoFlow-owned Codex MCP server, reported under the
 * selection the lock records. The block on disk and the recorded fingerprint agree — the resource is
 * intact, which is the whole point: only the selection differs between the two callers. */
function mcpReport({ mcpSelections }) {
  const home = scratch('doflow-inventory-mcp-home-');
  const project = scratch('doflow-inventory-mcp-project-');
  const block = '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n';
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, block);

  const ledger = defaultLedger({ scope: 'global', scopeRoot: home });
  ledger.targets.codex = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push({
    harness: 'codex', scope: 'global', assetId: 'guidance.codex-pointer', kind: 'mcp-server',
    identity: 'context7', target: configFile, ownershipIdentity: 'doflow:codex:mcp-server:context7',
    // The form src/adapters/codex/config.js records: sha256 of the block's JSON encoding.
    fingerprint: `sha256:${crypto.createHash('sha256').update(JSON.stringify(block)).digest('hex')}`,
    sourceVersion: 'test', selection: true, recoveryRef: null, projection: { renderer: 'codex-mcp' },
  });
  writeLedger(stateRoot({ scope: 'global', projectRoot: home, homeDir: home }), ledger);

  return withHomeDir(home, () => buildInventoryReport({
    repoRoot: REPO, projectRoot: project, targets: ['codex'],
    locks: { global: { ...defaultLock({ scope: 'global', scopeRoot: home }), targets: [{ harness: 'codex' }], mcpSelections }, project: null },
  }));
}

// ------------------------------- 6. silence about a resource is only evidence where the plan ran

/**
 * The remaining half of the same defect. Currency is derived from a resource's absence from the
 * scope's planned changes, and absence carries two meanings: the source would write nothing different
 * here, or nothing was ever computed for this harness. A harness whose adapter reported a conflict —
 * a malformed `config.toml` is the live case — emits a change set that is not a statement of what the
 * current source would write, so `matches` there asserts currency from a computation that never ran.
 *
 * The pair is the test: the same recorded resource, at a path no plan produces, reads `matches` when
 * its harness planned cleanly and `indeterminable` when its harness could not be planned at all.
 */
test('IC-002: a resource of a harness whose plan was refused is indeterminable, not current', () => {
  const clean = unplannableFixture({ config: 'model = "gpt-5"\n' });
  assert.equal(clean.copy.currency, 'matches',
    'the control: codex plans cleanly here, and a resource its plan does not mention is current');
  assert.equal(clean.copy.currencyReason, null);

  const refused = unplannableFixture({ config: 'model = \n' });
  assert.ok(refused.conflicts.length > 0,
    'the fixture must actually make the codex plan fail, or the assertion below proves nothing');
  assert.equal(refused.copy.currency, 'indeterminable',
    'no plan was produced for codex, so this copy was never compared with anything. Reporting it as '
    + 'current would be a claim with no computation behind it');
  assert.match(refused.copy.currencyReason, /no plan was produced for codex/,
    'and the reason says so, distinctly from the other two paths to the third value');
  assert.deepEqual(
    refused.report.findings.map((finding) => [finding.kind, finding.harness, finding.scope, finding.repairPath]),
    [[FINDING_KINDS.UNJUDGED_COPY, 'codex', 'global', MANUAL]],
    'and an unjudged copy is a finding (task H.1). This is the path a real install reaches: one malformed '
    + '`config.toml` makes the codex adapter refuse a plan and drops every copy of that harness out of '
    + 'evaluation, which is precisely what a caller needs told. IC-001 grants exit 0 only where every '
    + 'asset resolves to a copy that MATCHES what the current source would produce, and a copy nothing '
    + 'compared does not');
  assert.equal(refused.report.exitCode, 1,
    'so the report cannot answer "nothing requires attention" about a harness it never planned');
  assert.match(refused.report.summary, /1 unjudged-copy/,
    'the sentence a reader meets first names the kind, not merely a count');
  assert.equal(clean.report.exitCode, 0,
    'while the control still exits 0: the harness planned, the copy was compared, and nothing is wrong '
    + 'with it');

  // The rendering a human reads, which omitted this asset altogether: no finding meant no remedy, and
  // `printReport` skips every asset whose remedy is null.
  const rendered = render(refused.report);
  assert.match(rendered, new RegExp(escapeRe(refused.copy.location)),
    'the asset a reader must act on must appear in the human rendering at all');
  assert.match(rendered, /no plan was produced for codex/,
    'carrying the reason, so this stays distinguishable from the other three paths to the third value');
  assert.match(rendered, /doflow doctor/,
    'and the remedy names what would let the copy be judged — the refused plan has to be fixed first');
  assert.doesNotMatch(rendered, /restore/,
    'never a restore: the caller cannot know what a copy nothing compared should contain');
});

/** One recorded codex resource at a path no plan produces, beside a `config.toml` the caller chooses
 * — well-formed, or not well-formed enough for the codex adapter to plan at all. */
function unplannableFixture({ config }) {
  const home = scratch('doflow-inventory-refused-home-');
  const project = scratch('doflow-inventory-refused-project-');
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, config);

  const ledger = defaultLedger({ scope: 'global', scopeRoot: home });
  ledger.targets.codex = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push({
    harness: 'codex', scope: 'global', assetId: 'skills.doflow',
    ownershipIdentity: 'doflow:codex:copy-tree:skills.doflow:synthetic-041/SKILL.md',
    target: path.join(home, '.codex', 'skills', 'synthetic-041', 'SKILL.md'),
    sourceVersion: 'test', fingerprint: 'sha256:0000000000000000', projection: {}, recoveryRef: null, selection: null,
  });
  writeLedger(stateRoot({ scope: 'global', projectRoot: home, homeDir: home }), ledger);

  const scopes = withHomeDir(home, () => readScopes({
    registry: loadRegistry({ repoRoot: REPO }), repoRoot: REPO, projectRoot: project,
    targets: ['codex'], locks: { global: null, project: null },
  }));
  const report = withHomeDir(home, () => buildInventoryReport({
    repoRoot: REPO, projectRoot: project, targets: ['codex'], locks: { global: null, project: null },
  }));
  return { report, copy: report.assets[0].copies[0], conflicts: scopes.global.plan.conflicts };
}

// ------------------------- 7. FR-007's unit of reporting is the file, not the (asset, file) pair

/**
 * **Task F.3, finding 1: one unmanaged file is one finding, whatever the size of its directory.**
 *
 * The two questions are different and both are answered. IC-002 makes the asset entry the place
 * every threatened asset lists the unmanaged files that could outrank it, so a stray in a directory
 * holding four managed files appears on four entries — correctly, because a reader looking at any one
 * of those assets must see it. FR-007's unit is the file: "the system MUST report a file it does not
 * manage when that file sits in a directory the harness loads wholesale". Two foreign files are two
 * reportable facts.
 *
 * Emitting one finding per (asset, file) pair multiplied the two by four: a real install reported
 * `8 unmanaged-sibling` for two strays and `12` for three (validation §5 item 4, §9.5). The
 * multiplier is the number of managed files in the directory, a quantity the reader has no reason to
 * expect in a count of foreign files — and it landed in the summary sentence a reader acts on and in
 * the FR-006 repair-coverage denominator.
 *
 * The pair count is asserted beside the finding count deliberately: it is the old number, and it must
 * stay 8 while the finding count is 2, or the fix would have been made by dropping the per-asset
 * listing IC-002 requires.
 */
test('FR-007: one unmanaged file is one finding, though every managed asset in its directory lists it', () => {
  const fixture = siblingFixture(['ZZZ-not-ours.instructions.md', 'team-house-rules.instructions.md']);
  const report = fixture.report();

  const siblings = report.findings.filter((finding) => finding.kind === FINDING_KINDS.UNMANAGED_SIBLING);
  assert.deepEqual(siblings.map((finding) => finding.path).sort(), fixture.strays.sort(),
    'one finding per unmanaged file, each naming the file it is about — the count a reader acts on is '
    + 'the number of foreign files, not that number times the size of the directory');
  assert.equal(siblings.length, 2);

  assert.equal(report.assets.length, 4, 'the fixture must hold four managed assets in the one directory, '
    + 'or the inflation this test pins could not have arisen');
  assert.equal(report.assets.flatMap((asset) => asset.unmanaged).length, 8,
    'IC-002 is unchanged: all four assets still list both strays, which is the 8 the findings array '
    + 'used to report. If this drops to 2 the fix removed the per-asset listing instead');
  for (const asset of report.assets) {
    assert.deepEqual(asset.unmanaged.map((candidate) => candidate.path).sort(), fixture.strays.sort(),
      'every managed asset in the directory names every file that could outrank it (IC-002)');
    assert.equal(asset.remedy.actions.filter((action) => action.finding === FINDING_KINDS.UNMANAGED_SIBLING).length, 2,
      'and carries the literal review action for each of them (FR-009), on whichever entry a reader '
      + 'happens to be looking at');
  }

  assert.match(report.summary, /2 unmanaged-sibling/,
    'the sentence a reader meets first states the number of foreign files');
  assert.equal(report.repairCoverage.findings, 2,
    'the FR-006 denominator counts findings, so it inflated with them; 2 files, 2 rows');
  assert.equal(report.findings.filter((finding) => finding.kind === FINDING_KINDS.DIVERGENCE).length, 0,
    'the seeded paths are ones no plan produces, so nothing here is a divergence and the counts above '
    + 'are about siblings only');

  // The second half of the observed defect: a third stray gave 12 rather than 3.
  const three = siblingFixture([
    'ZZZ-not-ours.instructions.md', 'team-house-rules.instructions.md', 'third-party.instructions.md',
  ]).report();
  assert.equal(
    three.findings.filter((finding) => finding.kind === FINDING_KINDS.UNMANAGED_SIBLING).length, 3,
    'three foreign files are three findings (the reported figure was 12)');
  assert.equal(three.assets.flatMap((asset) => asset.unmanaged).length, 12);
});

// ------------------------------------- 8. a withheld verdict names no scope, because none is operative

/**
 * **Task F.3, finding 3: a withheld-verdict finding's `scope` is `null`.**
 *
 * Each finding's `scope` is read by `coverage.js` as the scope whose copy a remedy would have to
 * change, and each kind can say something true about it: a divergence names the diverged copy's
 * scope, a shadow the winning scope — the copy an edit must land on — and an unmanaged sibling the
 * scope whose copy put the directory in view. A withheld verdict is the one kind for which no scope
 * has been established as operative: that is what withholding the verdict means. It used to carry
 * `copies[0].scope`, which is `global` for every asset held at both scopes because `readScopes`
 * builds the global snapshot first, and on a real join that arbitrary value decided which lock graded
 * 346 findings (validation §9.8).
 *
 * Nothing is lost by refusing to name one. The scopes the asset is held at are on its entry, in
 * `verdict.presentAt`, and its remedy names both copies by path.
 */
test('IC-002: a withheld verdict names no scope, and a shadow names the winning one', () => {
  const report = withheldFixture();

  const [entry] = report.assets;
  assert.equal(entry.verdict.shadowed, true);
  assert.equal(entry.verdict.winner, null, 'gemini records an unestablished resolution mode, so no '
    + 'winner may be named — this fixture must reach the withheld branch');
  assert.equal(entry.copies[0].scope, 'global',
    'the copy that sorted first is the global one, which is the value the finding used to carry; the '
    + 'assertion below is a choice only while this stays true');

  const [finding] = report.findings;
  assert.equal(finding.kind, FINDING_KINDS.WITHHELD_VERDICT);
  assert.equal(finding.scope, null,
    'no scope has been established as operative for this asset, so the finding names none. Naming '
    + 'whichever copy was read first stated something no computation had established');
  assert.deepEqual(entry.verdict.presentAt.sort(), ['global', 'project'],
    'the scopes the asset is actually held at are on the asset entry, where they are a fact');
  assert.match(
    entry.remedy.actions.find((action) => action.finding === FINDING_KINDS.WITHHELD_VERDICT).action,
    /keep exactly one copy/,
    'and the remedy still names both copies by path, so the reader loses nothing to the null');

  // What a scope-less finding does to the grading: unrepairable, as it was before, and out of both
  // per-scope tallies. `coverage.js` reaches that verdict through `unknown-scope`, a reason written
  // for a caller naming a scope that does not exist; a reason of its own belongs to that module and
  // is recorded as a risk in design §7.
  const [row] = report.repairCoverage.details;
  assert.equal(row.repairable, false, 'no lock can repair a finding no scope owns — and a withheld '
    + 'verdict declares repairPath manual, so it was never repairable under either spelling');
  assert.equal(row.reason, REPAIR_REASONS.UNKNOWN_SCOPE);
  assert.equal(report.repairCoverage.repairable, 0,
    'the repairable count is what FR-006 is about, and it is unmoved by this change');
  assert.deepEqual(
    [report.repairCoverage.scopes.global.findings, report.repairCoverage.scopes.project.findings],
    [0, 0],
    'a finding belonging to no scope is counted in neither scope\'s tally, rather than added to the '
    + 'one whose snapshot happened to be read first'
  );

  // The other half of the rule: a shadow does name a scope, and it is the winning one.
  const { report: shadowed } = fixtureReport();
  const shadow = shadowed.findings.find((finding) => finding.kind === FINDING_KINDS.SHADOW);
  const shadowAsset = shadowed.assets.find((asset) => asset.identity === shadow.id);
  assert.equal(shadow.scope, shadowAsset.verdict.winner,
    'a shadow names the scope whose copy an edit must land on, which is the winning one');
  assert.equal(shadow.scope, 'global');
});

// ------------------------------------------------------------------ the fixtures for 7 and 8

/**
 * A global scope holding four managed copilot files in one wholesale-loaded directory, beside the
 * named strays. `.github/instructions` is wholesale for copilot (`siblings.js`'s `WHOLESALE_ASSETS`,
 * guarded by `test/guards/wholesale-assets.test.js`), and the managed basenames are synthetic so no
 * plan change matches them and no divergence clouds the sibling counts.
 */
function siblingFixture(strayNames) {
  const home = scratch('doflow-inventory-siblings-home-');
  const project = scratch('doflow-inventory-siblings-project-');
  const instructions = path.join(home, '.github', 'instructions');
  fs.mkdirSync(instructions, { recursive: true });

  const managed = ['a', 'b', 'c', 'd'].map((letter) => {
    const name = `synthetic-041-${letter}.instructions.md`;
    const target = path.join(instructions, name);
    fs.writeFileSync(target, 'managed');
    return {
      harness: 'copilot', scope: 'global', assetId: 'instructions.copilot',
      ownershipIdentity: `doflow:copilot:copy-tree:instructions.copilot:${name}`,
      target, sourceVersion: 'test', fingerprint: 'sha256:0000000000000000',
      projection: {}, recoveryRef: null, selection: null,
    };
  });
  const strays = strayNames.map((name) => {
    const stray = path.join(instructions, name);
    fs.writeFileSync(stray, 'not ours');
    return stray;
  });

  seedScope({ scope: 'global', scopeRoot: home, resources: managed, harness: 'copilot' });

  return {
    strays,
    report: () => withHomeDir(home, () => buildInventoryReport({
      repoRoot: REPO, projectRoot: project, targets: ['copilot'],
      locks: { global: { targets: [{ harness: 'copilot' }] }, project: null },
    })),
  };
}

/** One gemini asset held at both scopes. gemini records an established consultation order with an
 * explicitly unestablished resolution mode (IC-003's second state), so the verdict is withheld —
 * which is the only way to reach the finding kind this fixture exists for. */
function withheldFixture() {
  const home = scratch('doflow-inventory-withheld-home-');
  const project = scratch('doflow-inventory-withheld-project-');
  const ownershipIdentity = 'doflow:gemini:copy-tree:skills.doflow:synthetic-041/SKILL.md';
  const row = (scope, scopeRoot, native) => ({
    harness: 'gemini', scope, assetId: 'skills.doflow', ownershipIdentity,
    target: path.join(scopeRoot, ...native, 'skills', 'synthetic-041', 'SKILL.md'),
    sourceVersion: 'test', fingerprint: 'sha256:0000000000000000',
    projection: {}, recoveryRef: null, selection: null,
  });

  seedScope({
    scope: 'global', scopeRoot: home, harness: 'gemini',
    resources: [row('global', home, ['.gemini', 'config'])],
  });
  seedScope({
    scope: 'project', scopeRoot: project, harness: 'gemini',
    resources: [row('project', project, ['.agents'])],
  });

  return withHomeDir(home, () => buildInventoryReport({
    repoRoot: REPO, projectRoot: project, targets: ['gemini'],
    locks: {
      global: { targets: [{ harness: 'gemini' }] },
      project: { targets: [{ harness: 'gemini' }] },
    },
  }));
}

// ----------------------- 9. the report carries no field whose only possible value is a constant

/**
 * **Task F.3, finding 2: the inspected-but-not-reported count is gone from both renderings.**
 *
 * IC-002 asked the report to carry "the count of unmanaged entries that were inspected but not
 * individually reported". `inspectSiblings` inspects a directory in full and reports every unmanaged
 * entry in it, and never reads a directory it does not inspect, so that count was 0 on every input —
 * 0 on the runs that reported eight unmanaged siblings and twelve (validation §5 item 5, §9.6). A
 * field with one reachable value states nothing, and this one stated something false by implication:
 * `0` printed beside eight reported siblings reads as an assurance that eight more were not hidden,
 * from a report that has no hiding mechanism to reassure anyone about. IC-002 is amended to drop it.
 *
 * Both renderings are asserted because the field survived in one of them: the JSON payload stopped
 * carrying it while the human rendering still printed the line, so `doflow inventory` ended with
 * "Unmanaged entries inspected but not individually reported: undefined".
 */
test('IC-002: the report carries no inspected-but-not-reported count, in either rendering', () => {
  const { report } = fixtureReport();

  assert.equal(Object.prototype.hasOwnProperty.call(report, 'unmanagedNotReported'), false,
    'the dropped field must not come back as a constant 0; if the inspector ever gains a way to '
    + 'withhold an entry it inspected, the field earns reinstatement and IC-002 with it');
  assert.deepEqual(Object.keys(report), [
    'status', 'exitCode', 'summary', 'scopes', 'assets', 'unidentified', 'findings', 'repairCoverage',
  ], 'IC-002 fixes the field order, so the set and its order are asserted together');

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { printReport(report); } finally { console.log = original; }
  const rendered = lines.join('\n');

  assert.doesNotMatch(rendered, /not individually reported/,
    'the human rendering printed the dropped field, which is how it came to end with "undefined"');
  assert.doesNotMatch(rendered, /undefined/,
    'no rendering of this report may print undefined: every line is a fact the report carries');
  assert.match(rendered, /repairable by `doflow reconcile`/,
    'the repair-coverage sentence is now the last line, and must still be there');
});

// ----------- 10. a stale recorded row is not a content difference (IC-002: "the content differs")

/**
 * **Task G.1: a planned rewrite whose bytes are already on disk is `matches`, not `diverged`.**
 *
 * The whole input shape below was absent from this corpus, which is why the defect survived every
 * other test in this file: no fixture ever put the *correct* bytes on disk beside a *stale* recorded
 * fingerprint. Every existing divergence fixture reaches `diverged` through a destination that does
 * not exist at all, where the two cases are indistinguishable.
 *
 * `src/adapters/copy-tree.js` treats a destination as a no-op only when the location, the disk bytes
 * and the recorded row all agree with the source, which is correct for planning a write that also
 * refreshes the row — so it emits `update` when only the row is stale. That is routine rather than
 * exotic: the shared hooks asset projects one destination for claude, codex, gemini, kiro and
 * antigravity while ownership is recorded per harness, so the first harness to install refreshes
 * bytes the others' rows still describe by their old hash. On the machine this task was validated
 * against, `~/.doflow/shared/hooks/policies/user-prompt-submit.sh` was byte-identical to its source
 * and reported `diverged` for claude, `matches` for codex and `diverged` for gemini — one file, three
 * verdicts — with a remedy offering to "restore" a file that was already correct.
 *
 * `matches` is the value IC-002 assigns this, not `indeterminable`. The third value is defined as the
 * scope holding *no basis* for judging the content; here the basis is the strongest kind there is —
 * the plan ran, it named this exact resource, and the bytes it states the source would produce are
 * the bytes read off the destination. And the second value "states that the content differs", which
 * is false of it.
 *
 * The genuinely drifted row is in the same fixture on purpose: this test has to tell the two apart,
 * not merely accept the new answer for both.
 */
test('IC-002: a planned rewrite whose bytes are already on disk is current, while a real drift beside it is not', () => {
  const fixture = staleRowFixture();
  const report = fixture.report();

  // The fixture's own precondition, asserted rather than assumed: both rows really are planned
  // changes, and they differ only in whether the planned bytes are the bytes on disk. Without this
  // the assertions below could pass because no change was produced at all.
  assert.equal(fixture.plannedFingerprint(fixture.stale.ownershipIdentity), fixture.diskHash(fixture.stale.target),
    'the stale row must be a planned change whose fingerprint equals the destination bytes — if the '
    + 'asset gained a content transform, copy the transformed bytes here rather than the source file');
  assert.notEqual(fixture.plannedFingerprint(fixture.drifted.ownershipIdentity), fixture.diskHash(fixture.drifted.target),
    'and the drifted row must be a planned change whose fingerprint differs from the destination bytes');

  const byIdentity = new Map(report.assets.map((asset) => [asset.identity, asset]));
  const stale = byIdentity.get(`claude ${fixture.stale.ownershipIdentity}`);
  const drifted = byIdentity.get(`claude ${fixture.drifted.ownershipIdentity}`);
  assert.ok(stale && drifted, 'both seeded rows must be reported as logical assets');

  assert.equal(stale.copies[0].currency, 'matches',
    'the destination already holds the bytes the current source would write, so the content does not '
    + 'differ. IC-002: divergence STATES that the content differs — a stale ledger row is not a '
    + 'statement about content, and reporting it as one is the contradictory-verdicts defect');
  assert.doesNotMatch(stale.copies[0].currencyReason, /different content/,
    'and the reason may not claim the source would produce different content when it would not');
  assert.match(stale.copies[0].currencyReason, /already/,
    'the reason states the positive finding — the planned bytes are the bytes on disk');
  assert.equal(stale.remedy, null,
    'no finding, so no remedy: an offer to "restore" a file that is already byte-identical to its '
    + 'source is the over-claim FR-006 forbids');

  assert.equal(drifted.copies[0].currency, 'diverged',
    'the drifted row must still be a divergence — the fix withdraws a claim about bytes it read and '
    + 'found identical, and nothing more');
  assert.equal(drifted.copies[0].currencyReason, 'the current source would produce different content here');
  assert.ok(drifted.remedy.actions.some((action) => action.finding === FINDING_KINDS.DIVERGENCE),
    'and it still carries the restore action, which is the one thing `doflow reconcile` can perform');

  assert.deepEqual(report.findings.map((finding) => [finding.kind, finding.id]),
    [[FINDING_KINDS.DIVERGENCE, `claude ${fixture.drifted.ownershipIdentity}`]],
    'exactly one finding: the real drift. Two would mean the stale row is still reported; zero would '
    + 'mean the fix suppressed the real one');
  assert.equal(report.exitCode, 1);
});

// ----------------- 11. a row nobody compared is indeterminable, never the report's strongest claim

/**
 * **Task G.1: the unidentified branch stopped asserting `matches`.**
 *
 * A row carrying no harness or no ownership identity has no derivable cross-scope identity (IC-004),
 * and those are two of the four components the plan lookup is keyed by — so no planned change can
 * ever be found for such a row. It therefore fell through every test in `currencyOf` to the final
 * `matches`, the report's strongest claim, on the one row nothing had examined: a hand-edited ledger
 * produced `currency: matches`, `currencyReason: null` and exit 0 for a target that does not exist on
 * disk. IC-002's third value covers exactly this family, an absence of any basis for a judgement.
 *
 * The no-fingerprint row is here too. It is the condition IC-002 names *first* and it worked
 * correctly, but nothing asserted it — so the reason string it emits was free to drift.
 *
 * `printReport` is driven as well as `buildInventoryReport`, because the `unidentified` block is
 * rendered from fields no check re-reads: a dropped one prints `undefined` past every assertion, which
 * is exactly how this surface once shipped a report ending in "... : undefined".
 */
test('IC-002: a row with no derivable identity is indeterminable, and so is one with no fingerprint', () => {
  const report = unjoinableFixture();

  assert.equal(report.unidentified.length, 1,
    'the row carrying no ownership identity cannot be joined and is reported on its own');
  const [row] = report.unidentified;
  assert.equal(fs.existsSync(row.location), false,
    'the fixture must point at a file that does not exist, which is what made the old `matches` absurd');
  assert.equal(row.currency, 'indeterminable',
    'nothing compared this row: the plan lookup is keyed by the harness and the ownership identity, so '
    + 'a row missing either can never match a change and its absence from the plan is not evidence. '
    + '`matches` here was the strongest available claim made about the least examined row');
  assert.match(row.currencyReason, /could ever be looked up/,
    'and the reason says that nothing compared it, consistent with IC-002\'s other conditions for the '
    + 'third value rather than inventing a fourth meaning');
  assert.equal(row.ownershipIdentity, null);
  assert.match(row.reason, /no cross-scope identity could be derived/,
    'the separate cross-scope reason is unchanged: why it could not be joined, not why it was not judged');

  // The no-fingerprint path — IC-002's first condition, until now unasserted in any test.
  const [asset] = report.assets;
  assert.ok(asset, 'the identified-but-fingerprintless row must still be reported as a logical asset');
  assert.equal(asset.copies[0].currency, 'indeterminable');
  assert.equal(asset.copies[0].currencyReason, 'no fingerprint is recorded for this copy',
    'the first of IC-002\'s three conditions, pinned by its reason string so it stays distinguishable '
    + 'from the removal and never-planned paths');

  assert.deepEqual(report.findings.map((finding) => [finding.kind, finding.id, finding.scope, finding.repairPath]), [
    [FINDING_KINDS.UNJUDGED_COPY, asset.identity, 'global', MANUAL],
    [FINDING_KINDS.UNJUDGED_COPY, null, 'global', MANUAL],
  ], 'both rows are findings (task H.1), and the unidentified one is not exempt: a row missing the '
    + 'components the plan is keyed by is the commonest unjudged copy there is, so exempting the '
    + 'unidentified list would exempt the case most in need of reporting. The joined row names its '
    + 'identity, the unjoinable one names none — `id` is the cross-scope identity, which it has not got');
  assert.equal(report.exitCode, 1,
    'a hand-edited ledger pointing at a file that does not exist may not be reported as a sound install. '
    + 'This is the defect task H.1 fixed: exit 0 with one asset, judged by nothing');

  // Both renderings, because the JSON payload and the printed one have already disagreed once here.
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { printReport(report); } finally { console.log = original; }
  const rendered = lines.join('\n');

  assert.match(rendered, /1 resource\(s\) with no derivable cross-scope identity/,
    'a non-empty unidentified list must reach the human rendering at all — no other test in this file '
    + 'produces one, so this block was rendered only on real installs');
  assert.match(rendered, new RegExp(`${row.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — indeterminable`),
    'and the row prints its own location and currency');
  assert.doesNotMatch(rendered, /undefined/,
    'no rendering of this report may print undefined: a field dropped from an unidentified row would '
    + 'otherwise sail past every assertion above');

  // And the joined-but-fingerprintless asset, which the human rendering used to drop entirely.
  assert.match(rendered, new RegExp(escapeRe(asset.copies[0].location)),
    'the fingerprintless asset must reach the human rendering too — it is a finding, and a finding a '
    + 'reader cannot see is one the report failed to make');
  assert.match(rendered, /no fingerprint is recorded for this copy/,
    'with its own reason, which is a different absence from the unidentified row\'s and calls for a '
    + 'different action');
  assert.doesNotMatch(rendered, /restore/,
    'and neither row is offered a restore: what either copy should contain is exactly what is unknown');
});

// ----------------------------------------------------------------- the fixtures for 10 and 11

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A copy-tree ledger row in the shape `ledgerFileResources` recognises — `kind` and `identity`
 * (the source-relative path) are what make it a *previous* resource to `planTree`, and without them
 * a destination holding drifted-but-recorded bytes is refused as a hand edit instead of planned. */
function copyTreeRow({ relPath, target, fingerprint, harness = 'claude' }) {
  return {
    harness, scope: 'global', assetId: 'skills.doflow', kind: 'copy-tree-file', identity: relPath,
    ownershipIdentity: `doflow:${harness}:copy-tree:skills.doflow:${relPath}`,
    target, fingerprint, sourceVersion: 'test', projection: { renderer: 'copy-tree' },
    recoveryRef: null, selection: null,
  };
}

/**
 * One global scope holding two claude skill files, both of which the live plan produces a change
 * for, differing only in what is on disk:
 *
 *   - **the stale row** — the destination holds exactly the bytes the source would write, while the
 *     recorded fingerprint is another value entirely. `planTree` emits `update` because its no-op
 *     branch also requires the recorded row to agree; the content, however, is current.
 *   - **the drifted row** — the destination holds different bytes, and the recorded fingerprint is
 *     the hash of *those* bytes. Recording the drift is what keeps this a planned change rather than
 *     a `was modified outside DoFlow` conflict, which would make the whole harness indeterminable
 *     and prove nothing.
 */
function staleRowFixture() {
  const home = scratch('doflow-inventory-stale-home-');
  const project = scratch('doflow-inventory-stale-project-');
  const skills = path.join(home, '.claude', 'skills');

  const stale = { relPath: 'do/SKILL.md', target: path.join(skills, 'do', 'SKILL.md') };
  const drifted = { relPath: 'do-design/SKILL.md', target: path.join(skills, 'do-design', 'SKILL.md') };
  for (const row of [stale, drifted]) {
    row.ownershipIdentity = `doflow:claude:copy-tree:skills.doflow:${row.relPath}`;
    fs.mkdirSync(path.dirname(row.target), { recursive: true });
  }
  // `skills.doflow` declares no transform or layout for claude, so the source bytes are the bytes
  // the plan would write; the test asserts that equality rather than trusting it.
  fs.copyFileSync(path.join(REPO, 'core', 'shared', 'skills', stale.relPath), stale.target);
  fs.writeFileSync(drifted.target, '# a real hand-installed drift\n');

  seedScope({
    scope: 'global',
    scopeRoot: home,
    resources: [
      copyTreeRow({ ...stale, fingerprint: '0'.repeat(64) }),
      copyTreeRow({ ...drifted, fingerprint: sha256File(drifted.target) }),
    ],
  });

  const plan = () => withHomeDir(home, () => readScopes({
    registry: loadRegistry({ repoRoot: REPO }), repoRoot: REPO, projectRoot: project,
    targets: ['claude'], locks: { global: null, project: null },
  })).global.plan;

  return {
    stale,
    drifted,
    diskHash: (target) => sha256File(target),
    plannedFingerprint: (ownershipIdentity) =>
      (plan().changes.find((change) => change.ownershipIdentity === ownershipIdentity) ?? {}).fingerprint,
    report: () => withHomeDir(home, () => buildInventoryReport({
      repoRoot: REPO, projectRoot: project, targets: ['claude'],
      locks: { global: { targets: [{ harness: 'claude' }] }, project: null },
    })),
  };
}

/**
 * A hand-edited global ledger holding the two rows no install produces and a JSON file can:
 * one with no `ownershipIdentity` at all — unjoinable, and unlookupable in the plan with it — and one
 * carrying an identity but no fingerprint. Both targets are absent from disk, which is what makes the
 * old `matches` on the first of them impossible to defend.
 */
function unjoinableFixture() {
  const home = scratch('doflow-inventory-unjoinable-home-');
  const project = scratch('doflow-inventory-unjoinable-project-');
  const base = copyTreeRow({
    relPath: 'synthetic-041/SKILL.md',
    target: path.join(home, '.claude', 'skills', 'synthetic-041', 'SKILL.md'),
    fingerprint: '0'.repeat(64),
  });
  const orphan = { ...base, target: path.join(home, '.claude', 'skills', 'orphan-041', 'SKILL.md') };
  delete orphan.ownershipIdentity;

  seedScope({
    scope: 'global',
    scopeRoot: home,
    resources: [{ ...base, fingerprint: null }, orphan],
  });

  return withHomeDir(home, () => buildInventoryReport({
    repoRoot: REPO, projectRoot: project, targets: ['claude'],
    locks: { global: { targets: [{ harness: 'claude' }] }, project: null },
  }));
}
