'use strict';

// G4 — flag vocabulary. The `## Flags and runtime` section of rules/RULES.md is loaded into every
// session on every harness, so a flag named there that routes to nothing is pure context cost that
// also misleads: it advertises a capability the framework does not have. It names only the shared
// flags; a flag one skill consumes is owned by that skill's `argument-hint` (row 130 moved
// `--focus` out of the core for this reason), and the always-loaded set may name no other.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE, coreTextFiles, skillFiles } = require('./_shared.ts');
const { alwaysLoaded } = require('../helper/always-loaded.ts');

const RULES_REL = 'core/shared/guidance/rules/RULES.md';
const RULES = path.join(GUIDANCE, 'rules', 'RULES.md');
const SECTION = /^## Flags and runtime$/m;

/** The flags section of RULES.md: from its heading to the next `## ` heading. Empty when absent. */
function flagsSection(text: any) {
  const start = text.search(SECTION);
  if (start === -1) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
const flagsText = () => flagsSection(fs.readFileSync(RULES, 'utf8'));

/** Same extraction G8/G10 already uses for argument-hint -> flag list: read the frontmatter's
 * argument-hint string, then pull every `--flag` token out of it. */
function argumentHintFlags(file: any) {
  const hint = fs.readFileSync(file, 'utf8').match(/^argument-hint:\s*"?(.*?)"?\s*$/m)?.[1];
  if (!hint) return new Set();
  return new Set([...hint.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
}

/** Every skill's declared argument-hint flags as a Map (name -> Set of flags). */
function skillFlagDeclarations() {
  const declarations: any = new Map();
  for (const { name, file } of skillFiles()) {
    declarations.set(name, argumentHintFlags(file));
  }
  return declarations;
}

/** G4 shared set check: pure function (flagsText, declarations) -> findings[].
 * The flags section's "shared" line must name backticked flags equal to those declared in at least two skills' argument-hint. */
function checkSharedFlags(flagsText: any, declarations: any) {
  const findings: any = [];
  if (/\bevery flag belongs to one skill\b/i.test(flagsText) || /\bwhich crosses them\b/i.test(flagsText)) {
    findings.push('the flags section claims "Every flag belongs to one skill and is declared in that skill\'s `argument-hint`, except this one, which crosses them:" (re-seeded fault)');
    return findings;
  }

  const lines = flagsText.split('\n');
  const sharedLine = lines.find((line: any) => /\bshared\b/i.test(line));
  if (!sharedLine) {
    findings.push('flags section: found no anchor line containing "shared"');
    return findings;
  }

  const named = [...sharedLine.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]).sort();

  const declEntries = declarations instanceof Map ? declarations.entries() : Object.entries(declarations);
  const counts: any = new Map();
  for (const [, flags] of declEntries) {
    for (const flag of flags) {
      counts.set(flag, (counts.get(flag) || 0) + 1);
    }
  }
  const expected = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([flag]) => flag)
    .sort();

  if (named.length !== expected.length || !named.every((f, i) => f === expected[i])) {
    findings.push(`flags section: shared flags [${named.join(', ')}] do not match flags declared by at least two skills [${expected.join(', ')}]`);
  }

  return findings;
}

// Suppressions must carry a reason so each one is visible in review rather than accumulating
// silently. A flag consumed behaviourally by the model — rather than by a file reference a scan
// can see — is the only legitimate entry.
const BEHAVIOURAL_ONLY: any = new Map([]);

// CLI and skill-local arguments quoted inside guidance prose. They belong to a command or to a
// single skill's own argument-hint, not to this framework's global flag vocabulary, so the flags
// section neither documents nor owns them. Each entry needs a reason, like BEHAVIOURAL_ONLY above.
const NOT_FRAMEWORK_FLAGS: any = new Map<string, string>([
  ...['--id', '--points', '--dir'].map(flag => [flag, 'package verb argument']),
  ...['--action', '--calling-skill', '--note', '--result', '--task-class', '--task-id']
    .map(flag => [flag, 'orchestrate CLI argument documented in WORKFLOW_HANDOFF.md; owned by the runtime parser, not the global framework vocabulary']),
  ['--mcp-outcome', 'orchestrate CLI argument documented in WORKFLOW_HANDOFF.md'],
  ['--json', 'output mode of do-paths.sh / do-prereqs.sh / validate-artifacts.sh, quoted in DOFLOW_CHAIN.md'],
  ['--scaffold', "do-execute-plan's own argument, described in DOFLOW_CHAIN.md"],
  ['--slug', 'feature-override argument of do-paths.sh / do-prereqs.sh / validate-artifacts.sh, quoted in ARTIFACT_FORMAT.md'],
  ['--role', "the runtime claim verb's own argument (claim --action add --role root-cause), quoted in EVIDENCE_LEDGER.md"],
  ['--evidence-id', "the runtime evidence verb's own argument (evidence --action supersede --evidence-id ...), quoted in EVIDENCE_LEDGER.md"],
  ['--batch', "the runtime decision verb's own argument (decision --action add --batch <file>.json), quoted in WORKFLOW_HANDOFF.md"],
  ...['--stage', '--statement']
    .map(flag => [flag, "the runtime followup verb's own argument (followup --action add --stage <stage> --statement ...), quoted in WORKFLOW_HANDOFF.md"]),
  ['--replaced-by', "the runtime evidence verb's own argument (evidence --action supersede ... --replaced-by ...), quoted in EVIDENCE_LEDGER.md"],
] as any);

/** Every backticked flag the flags section names. */
function documentedFlags() {
  return [...new Set([...flagsText().matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]))];
}

/** The flags the section's "shared" line names: the only flags no single skill owns. */
function sharedLineFlags(text: any) {
  const line = text.split('\n').find((l: any) => /\bshared\b/i.test(l)) ?? '';
  return new Set([...line.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]));
}

/** G4 consumer check: pure function (files, declarations, shared) -> findings[]. Wherever a guidance
 * or skill file says which skill consumes a flag ("Consumed by `skill`", the form FLAGS.md used),
 * each named skill must declare that flag in its argument-hint, and for a flag that is not shared
 * the named skills must be exactly the skills that declare it. */
function checkFlagConsumers(files: any, declarations: any, shared: any) {
  const findings: any = [];
  const declarers = (flag: any) => [...declarations.entries()].filter(([, flags]: any) => flags.has(flag)).map(([skill]: any) => skill).sort();
  for (const { rel, text } of files) {
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)(?![\w-])[^\n]*?\bconsumed\s+by\b([^.\n]*)/gi)) {
        const flag = m[1];
        const named = [...m[2].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((x) => x[1]).sort();
        const expected = declarers(flag);
        if (!named.length) { findings.push(`${rel}: ${flag} names no consuming skill after "Consumed by"`); continue; }
        const undeclared = named.filter((skill) => !expected.includes(skill));
        if (undeclared.length) findings.push(`${rel}: ${flag} consumers [${named.join(', ')}] include skills whose argument-hint does not declare it [${undeclared.join(', ')}]; declared by [${expected.join(', ')}]`);
        else if (!shared.has(flag) && named.join() !== expected.join()) findings.push(`${rel}: ${flag} consumers [${named.join(', ')}] do not match skills declaring it in argument-hint [${expected.join(', ')}]`);
      }
    }
  }
  return findings;
}

/** Every flag some skill declares in its argument-hint: the owner of a skill-local flag. */
function declaredFlags() {
  return new Set([...skillFlagDeclarations().values()].flatMap((flags: any) => [...flags]));
}

test('G4: RULES.md has the flags section and it names at least one flag', () => {
  assert.notEqual(flagsText(), '', `${RULES_REL} has no "## Flags and runtime" section`);
  assert.ok(documentedFlags().length > 0, 'the flags section names no flag; the shared-set check below would bind nothing');
});

test('G4: every flag documented in the flags section is referenced somewhere else in core/', () => {
  const elsewhere = coreTextFiles({ exclude: [RULES_REL] });
  const dead = documentedFlags().filter((flag) => {
    if (BEHAVIOURAL_ONLY.has(flag)) return false;
    const pattern: any = new RegExp(`${flag}(?![a-z0-9-])`);
    return !elsewhere.some(({ text }: any) => pattern.test(text));
  });
  assert.deepEqual(dead, [],
    `flags documented but wired to nothing (remove them, or add a reasoned BEHAVIOURAL_ONLY entry):\n  ${dead.join('\n  ')}`);
});

test('G4: the always-loaded set does not enumerate MCP servers', () => {
  const named = alwaysLoaded().files.flatMap(({ rel }: any) => {
    const text = fs.readFileSync(path.join(GUIDANCE, rel), 'utf8');
    return ['context7', 'sequential-thinking', 'chrome-devtools', 'playwright']
      .filter((server) => text.includes(server)).map((server) => `${rel}: ${server}`);
  });
  assert.deepEqual(named, [],
    'per-install MCP advertisement belongs to the generated MCP_INDEX.md; naming servers here '
    + 'advertises ones the user may not have installed');
});

// The reverse direction, which G3 has had from the start: a flag named anywhere in the guidance
// tree must have an owner — the shared line, or the argument-hint of a skill that declares it.
// Without it, removing a flag leaves every mention of it behind as a pointer to something that no
// longer exists — silently, because the forward check only ever looks at what is still listed.
test('G4: every flag referenced in the guidance tree is shared or declared by a skill', () => {
  const owned: any = new Set([...sharedLineFlags(flagsText()), ...declaredFlags()]);
  const dangling: any = [];
  // Scoped to the guidance tree on purpose: hook scripts are full of ordinary CLI flags that this
  // guard has no business tracking.
  const inGuidance = ({ rel }: any) => rel.startsWith('core/shared/guidance/') && rel.endsWith('.md');
  for (const { rel, text } of coreTextFiles().filter(inGuidance)) {
    for (const [, flag] of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]{2,})(?![\w-])/g)) {
      if (NOT_FRAMEWORK_FLAGS.has(flag)) continue;
      if (!owned.has(flag)) dangling.push(`${rel} -> ${flag}`);
    }
  }
  assert.deepEqual([...new Set(dangling)].sort(), [],
    `flags referenced in guidance with no owner (shared line or a skill argument-hint):\n  ${[...new Set(dangling)].sort().join('\n  ')}`);
});

// A single-skill flag belongs in its skill, never in the always-loaded set: only the shared line's
// flags may appear there.
function coreSkillLocalFlags(files: any, shared: any) {
  return files.flatMap(({ rel, text }: any) => [...text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]{2,})(?![\w-])/g)]
    .map((m) => m[1]).filter((flag) => !shared.has(flag)).map((flag) => `${rel} -> ${flag}`));
}

test('G4: the always-loaded set names no flag but the shared ones', () => {
  const files = alwaysLoaded().files.map(({ rel }: any) => ({ rel, text: fs.readFileSync(path.join(GUIDANCE, rel), 'utf8') }));
  assert.deepEqual(coreSkillLocalFlags(files, sharedLineFlags(flagsText())), [],
    'a single-skill flag in the always-loaded set is context every session pays; document it in the skill');
});

const consumerFiles = () => coreTextFiles().filter(({ rel }: any) => /^core\/shared\/(guidance|skills)\/.*\.md$/.test(rel));

test('G4: flag consumers — a skill named as a flag\'s consumer declares it in its argument-hint', () => {
  const findings = checkFlagConsumers(consumerFiles(), skillFlagDeclarations(), sharedLineFlags(flagsText()));
  assert.deepEqual(findings, [], `flag consumers that do not declare the flag:\n  ${findings.join('\n  ')}`);
});

test('G4: control — a backticked flag documented with the wrong consumer is red (the Sol plant)', () => {
  const text = flagsText();
  const decls = skillFlagDeclarations();
  const shared = sharedLineFlags(text);
  const planted = [{ rel: RULES_REL, text: `${text}\n\`--fix\` applies the fix in place. Consumed by \`do-plan\`.\n` }];
  assert.deepEqual(checkFlagConsumers(planted, decls, shared),
    [`${RULES_REL}: --fix consumers [do-plan] include skills whose argument-hint does not declare it [do-plan]; declared by [do-diagnose]`]);
  // The same plant in the always-loaded set is also a single-skill flag there.
  assert.deepEqual(coreSkillLocalFlags(planted.map(({ text: t }) => ({ rel: 'rules/RULES.md', text: t })), shared), ['rules/RULES.md -> --fix']);
  // The right consumer passes; a missing consumer list does not.
  assert.deepEqual(checkFlagConsumers([{ rel: 'x.md', text: '`--fix` applies it. Consumed by `do-diagnose`.' }], decls, shared), []);
  assert.match(checkFlagConsumers([{ rel: 'x.md', text: '`--fix` is consumed by the diagnose skill.' }], decls, shared)[0], /names no consuming skill/);
  // A shared flag may name any subset of its declarers, never a skill that does not declare it.
  assert.deepEqual(checkFlagConsumers([{ rel: 'x.md', text: '`--depth`: consumed by `do-plan`.' }], decls, shared), []);
  assert.equal(checkFlagConsumers([{ rel: 'x.md', text: '`--depth`: consumed by `do-git`.' }], decls, shared).length, 1);
});

test('G4: every BEHAVIOURAL_ONLY suppression names a flag that is still documented', () => {
  const documented: any = new Set(documentedFlags());
  const stale = [...BEHAVIOURAL_ONLY.keys()].filter((flag) => !documented.has(flag));
  assert.deepEqual(stale, [], 'suppressions for flags that no longer exist must be deleted');
});

test('G4: shared set — backticked flags on the shared line equal flags declared by at least two skills', () => {
  const text = flagsText();
  const decls = skillFlagDeclarations();
  const findings = checkSharedFlags(text, decls);
  assert.deepEqual(findings, [],
    `RULES.md shared-flags line does not match skills declaring flags:\n  ${findings.join('\n  ')}`);
});

test('G4: controls — shared-set and core-flag checks detect re-seeded faults and missing anchors', () => {
  const text = flagsText();
  const decls = skillFlagDeclarations();

  // Re-seed control: C1 baseline fault in shared-set check
  const reseededShared = text.replace(
    /.*shared.*\n?/i,
    "Every flag belongs to one skill and is declared in that skill's `argument-hint`, except this one, which crosses them:\n",
  );
  const sharedFaultFindings = checkSharedFlags(reseededShared, decls);
  assert.equal(sharedFaultFindings.length, 1);
  assert.match(sharedFaultFindings[0], /belongs to one skill/i);

  // Vacuity control: shared-set check with no anchor
  const vacuousShared = text.replace(/.*shared.*\n?/i, '');
  const sharedVacuityFindings = checkSharedFlags(vacuousShared, decls);
  assert.equal(sharedVacuityFindings.length, 1);
  assert.match(sharedVacuityFindings[0], /found no anchor/);

  // Re-seed control: the --focus entry the retired FLAGS.md carried, planted back into the core
  const planted = [{ rel: 'rules/RULES.md', text: `${text}\n**--focus [quality|security]** — narrows analysis. Consumed by \`do-diagnose\`.\n` }];
  assert.deepEqual(coreSkillLocalFlags(planted, sharedLineFlags(text)), ['rules/RULES.md -> --focus']);

  // Vacuity control: the section extractor finds nothing once the heading is gone
  assert.equal(flagsSection(text.replace(SECTION, '## Something else')), '');
});
