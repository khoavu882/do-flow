'use strict';

// G4 — flag consumers. FLAGS.md is loaded into every session on every harness, so a flag that
// routes to nothing is pure context cost that also misleads: it advertises a capability the
// framework does not have.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE, coreTextFiles, skillFiles } = require('./_shared');

const FLAGS = path.join(GUIDANCE, 'FLAGS.md');

/** Same extraction G8/G10 already uses for argument-hint -> flag list: read the frontmatter's
 * argument-hint string, then pull every `--flag` token out of it. */
function argumentHintFlags(file) {
  const hint = fs.readFileSync(file, 'utf8').match(/^argument-hint:\s*"?(.*?)"?\s*$/m)?.[1];
  if (!hint) return new Set();
  return new Set([...hint.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
}

/** Every skill's declared argument-hint flags as a Map (name -> Set of flags). */
function skillFlagDeclarations() {
  const declarations = new Map();
  for (const { name, file } of skillFiles()) {
    declarations.set(name, argumentHintFlags(file));
  }
  return declarations;
}

/** G4 shared set check: pure function (flagsText, declarations) -> findings[].
 * FLAGS.md's "shared" line must name backticked flags equal to those declared in at least two skills' argument-hint. */
function checkSharedFlags(flagsText, declarations) {
  const findings = [];
  if (/\bevery flag belongs to one skill\b/i.test(flagsText) || /\bwhich crosses them\b/i.test(flagsText)) {
    findings.push('FLAGS.md claims "Every flag belongs to one skill and is declared in that skill\'s `argument-hint`, except this one, which crosses them:" (re-seeded fault)');
    return findings;
  }

  const lines = flagsText.split('\n');
  const sharedLine = lines.find((line) => /\bshared\b/i.test(line));
  if (!sharedLine) {
    findings.push('FLAGS.md: found no anchor line containing "shared"');
    return findings;
  }

  const named = [...sharedLine.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]).sort();

  const declEntries = declarations instanceof Map ? declarations.entries() : Object.entries(declarations);
  const counts = new Map();
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
    findings.push(`FLAGS.md: shared flags [${named.join(', ')}] do not match flags declared by at least two skills [${expected.join(', ')}]`);
  }

  return findings;
}

/** G4 flag consumers check: pure function (flagsText, declarations) -> findings[].
 * For every **--flag ...** entry, the backticked skill names after "Consumed by" must equal
 * the skills whose argument-hint declares that flag. */
function checkFlagConsumers(flagsText, declarations) {
  const findings = [];
  const entries = [];
  const regex = /^\*\*(--[a-z0-9-]+)[^*]*\*\*/gm;
  const matches = [...flagsText.matchAll(regex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const startIndex = match.index;
    const nextStart = i + 1 < matches.length ? matches[i + 1].index : flagsText.length;
    const block = flagsText.slice(startIndex, nextStart);
    const endPos = block.search(/\n\s*\n|\n##\s/);
    const entryText = endPos !== -1 ? block.slice(0, endPos) : block;
    entries.push({
      flag: match[1],
      body: entryText.slice(match[0].length),
    });
  }

  if (entries.length === 0) {
    findings.push('FLAGS.md: found no anchor: no **--flag ...** entries found');
    return findings;
  }

  const declEntries = declarations instanceof Map ? declarations.entries() : Object.entries(declarations);
  const declMap = new Map();
  for (const [skill, flags] of declEntries) {
    declMap.set(skill, flags instanceof Set ? flags : new Set(flags));
  }

  for (const { flag, body } of entries) {
    const consumedMatch = body.match(/consumed\s+by\b([\s\S]*?)(?:\.|$)/i);
    if (!consumedMatch) {
      findings.push(`entry for ${flag}: found no anchor: missing "Consumed by" clause`);
      continue;
    }
    const actualSkills = [...consumedMatch[1].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]).sort();
    const expectedSkills = [];
    for (const [skill, flags] of declMap) {
      if (flags.has(flag)) expectedSkills.push(skill);
    }
    expectedSkills.sort();

    if (actualSkills.length !== expectedSkills.length || !actualSkills.every((s, i) => s === expectedSkills[i])) {
      findings.push(`entry for ${flag}: consumers [${actualSkills.join(', ')}] do not match skills declaring it in argument-hint [${expectedSkills.join(', ')}]`);
    }
  }

  return findings;
}

// Suppressions must carry a reason so each one is visible in review rather than accumulating
// silently. A flag consumed behaviourally by the model — rather than by a file reference a scan
// can see — is the only legitimate entry.
const BEHAVIOURAL_ONLY = new Map([]);

// CLI and skill-local arguments quoted inside guidance prose. They belong to a command or to a
// single skill's own argument-hint, not to this framework's global flag vocabulary, so FLAGS.md
// neither documents nor owns them. Each entry needs a reason, like BEHAVIOURAL_ONLY above.
const NOT_FRAMEWORK_FLAGS = new Map([
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
]);

function documentedFlags() {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const flags = new Set();
  for (const [, group] of text.matchAll(/^\*\*(--[^*]+)\*\*/gm)) {
    for (const [, flag] of group.matchAll(/(--[a-z0-9-]+)/g)) flags.add(flag);
  }
  return [...flags];
}

test('G4: every flag documented in FLAGS.md is referenced somewhere else in core/', () => {
  const elsewhere = coreTextFiles({ exclude: ['core/shared/guidance/FLAGS.md'] });
  const dead = documentedFlags().filter((flag) => {
    if (BEHAVIOURAL_ONLY.has(flag)) return false;
    const pattern = new RegExp(`${flag}(?![a-z0-9-])`);
    return !elsewhere.some(({ text }) => pattern.test(text));
  });
  assert.deepEqual(dead, [],
    `flags documented but wired to nothing (remove them, or add a reasoned BEHAVIOURAL_ONLY entry):\n  ${dead.join('\n  ')}`);
});

test('G4: FLAGS.md does not enumerate MCP servers', () => {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const named = ['context7', 'sequential-thinking', 'chrome-devtools', 'playwright']
    .filter((server) => text.includes(server));
  assert.deepEqual(named, [],
    'per-install MCP advertisement belongs to the generated MCP_INDEX.md; naming servers here '
    + 'advertises ones the user may not have installed');
});

// The reverse direction, which G3 has had from the start and this guard did not: a flag named
// anywhere in core/ must be documented in FLAGS.md. Without it, removing a flag leaves every
// mention of it behind as a pointer to something that no longer exists — silently, because the
// forward check only ever looks at what FLAGS.md still lists.
test('G4: every flag referenced in core/ is documented in FLAGS.md', () => {
  const documented = new Set(documentedFlags());
  const dangling = [];
  // Scoped to the guidance tree on purpose. Guidance and FLAGS.md share one vocabulary; a skill's
  // own arguments are declared in its argument-hint and owned there, and hook scripts are full of
  // ordinary CLI flags that this file has no business tracking.
  const inGuidance = ({ rel }) => rel.startsWith('core/shared/guidance/') && rel.endsWith('.md');
  for (const { rel, text } of coreTextFiles({ exclude: ['core/shared/guidance/FLAGS.md'] }).filter(inGuidance)) {
    for (const [, flag] of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]{2,})(?![\w-])/g)) {
      if (NOT_FRAMEWORK_FLAGS.has(flag)) continue;
      if (!documented.has(flag)) dangling.push(`${rel} -> ${flag}`);
    }
  }
  assert.deepEqual([...new Set(dangling)].sort(), [],
    `flags referenced but not documented in FLAGS.md:\n  ${[...new Set(dangling)].sort().join('\n  ')}`);
});

test('G4: every BEHAVIOURAL_ONLY suppression names a flag that is still documented', () => {
  const documented = new Set(documentedFlags());
  const stale = [...BEHAVIOURAL_ONLY.keys()].filter((flag) => !documented.has(flag));
  assert.deepEqual(stale, [], 'suppressions for flags that no longer exist must be deleted');
});

test('G4: shared set — backticked flags on the shared line equal flags declared by at least two skills', () => {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const decls = skillFlagDeclarations();
  const findings = checkSharedFlags(text, decls);
  assert.deepEqual(findings, [],
    `FLAGS.md shared-flags line does not match skills declaring flags:\n  ${findings.join('\n  ')}`);
});

test('G4: flag consumers — skills listed after Consumed by equal skills declaring the flag', () => {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const decls = skillFlagDeclarations();
  const findings = checkFlagConsumers(text, decls);
  assert.deepEqual(findings, [],
    `FLAGS.md flag consumers do not match skill argument-hints:\n  ${findings.join('\n  ')}`);
});

test('G4: controls — shared-set and consumer checks detect re-seeded faults and missing anchors', () => {
  const text = fs.readFileSync(FLAGS, 'utf8');
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

  // Re-seed control: wrong consumer in flag consumers check
  const reseededConsumer = text.replace('`do-diagnose`', '`do-plan`');
  const consumerFaultFindings = checkFlagConsumers(reseededConsumer, decls);
  assert.equal(consumerFaultFindings.length, 1);
  assert.match(consumerFaultFindings[0], /consumers \[do-plan\] do not match/);

  // Vacuity control: consumer check with missing "Consumed by" anchor
  const vacuousConsumer = text.replace(/Consumed[\s\S]*?`do-diagnose`\./i, '');
  const consumerVacuityFindings = checkFlagConsumers(vacuousConsumer, decls);
  assert.equal(consumerVacuityFindings.length, 1);
  assert.match(consumerVacuityFindings[0], /found no anchor/);
});
