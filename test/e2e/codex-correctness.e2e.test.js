'use strict';
// Codex install, update and remove against a config.toml the user already wrote to: a server table of
// the user's own, an empty or dotted [features] entry, a [features] value DoFlow cannot extend. Each
// case spawns bin/doflow.js in a scratch HOME and XDG folder and reads the result back, with Python's
// tomllib as the parser that is not DoFlow's own.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { loadRegistry } = require('../../src/registry');
const { readCodexMcpCatalog, renderServer } = require('../../src/adapters/codex/mcp');
const { fingerprint } = require('../../src/adapters/codex/config');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const HAS_TOMLLIB = spawnSync('python3', ['-c', 'import tomllib']).status === 0;
const NO_TOMLLIB = HAS_TOMLLIB ? false : 'python3 with tomllib is not available';
const scratches = [];
after(() => { for (const scratch of scratches) scratch.remove(); });

const USER_TABLE = '[mcp_servers.context7]\ncommand = "mine"\n';
const KEPT_LINE = /kept your own entry 'context7'/;

function setup(prefix) {
  const scratch = createScratch(`doflow-codex-${prefix}-`);
  scratches.push(scratch);
  const codexDir = path.join(scratch.home, '.codex');
  const config = path.join(codexDir, 'config.toml');
  const ledger = path.join(scratch.home, '.doflow', 'state', 'ledger.json');
  const doflow = (...args) => spawnSync('node', [DOFLOW, ...args], { env: scratch.env(), input: '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const ok = (...args) => {
    const r = doflow(...args);
    assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r;
  };
  const write = (text, mode = 0o600) => {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(config, text);
    fs.chmodSync(config, mode);
  };
  const mode = () => fs.statSync(config).mode & 0o7777;
  const text = () => fs.readFileSync(config, 'utf8');
  const readLedger = () => JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const mcpRows = () => readLedger().resources.filter((row) => row.harness === 'codex' && row.kind === 'mcp-server');
  const checkLedgerVersion = () => assert.equal(readLedger().version, 2);
  return { scratch, config, ledger, doflow, ok, write, mode, text, readLedger, mcpRows, checkLedgerVersion };
}

/** The file's TOML as Python parses it. */
function parseToml(file) {
  const r = spawnSync('python3', ['-c', 'import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${file} must parse as TOML\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function headerCount(text, header) {
  return text.split('\n').filter((line) => line.trim() === header).length;
}

function catalogContext7() {
  const registry = loadRegistry({ repoRoot: REPO });
  const definition = readCodexMcpCatalog(registry).serverDefs.context7;
  assert.ok(definition, 'the catalog holds context7');
  return definition;
}

test('a user table named context7 survives install, update and remove, and is never recorded', () => {
  const c = setup('user-table');
  c.write(USER_TABLE);

  const dry = c.ok('install', '-g', '-t', 'codex', '--mcp', 'context7', '-f', '--dry-run');
  const dryLines = dry.stdout.split('\n').filter((line) => KEPT_LINE.test(line));
  assert.equal(dryLines.length, 1, dry.stdout);
  assert.match(dryLines[0], /\[DRY\]/);
  assert.equal(c.text(), USER_TABLE, 'a dry run writes nothing');

  const installed = c.ok('install', '-g', '-t', 'codex', '--mcp', 'context7', '-f');
  assert.equal(installed.stdout.split('\n').filter((line) => KEPT_LINE.test(line)).length, 1, installed.stdout);
  assert.equal(c.text().startsWith(USER_TABLE), true, 'the table bytes are unchanged');
  assert.equal(headerCount(c.text(), '[mcp_servers.context7]'), 1);
  assert.deepEqual(c.mcpRows().filter((row) => row.identity === 'context7'), []);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();
  const afterInstall = c.text();

  const updated = c.ok('update', '-g', '-t', 'codex', '-f');
  assert.doesNotMatch(updated.stdout + updated.stderr, /modified outside DoFlow/);
  assert.match(updated.stdout, KEPT_LINE);
  assert.equal(c.text(), afterInstall);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();

  const removed = c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.doesNotMatch(removed.stdout + removed.stderr, /modified outside DoFlow/);
  assert.equal(c.text().startsWith(USER_TABLE), true, 'the table bytes are unchanged after remove');
  assert.equal(headerCount(c.text(), '[mcp_servers.context7]'), 1);
  assert.equal(c.mode(), 0o600);
});

test('with no table of the user\'s, DoFlow writes, keeps and removes its own context7 table', () => {
  const c = setup('own-table');
  c.ok('install', '-g', '-t', 'codex', '--mcp', 'context7', '-f');
  const own = renderServer('context7', catalogContext7());
  assert.ok(c.text().includes(own), 'the table is DoFlow\'s rendering');
  assert.equal(headerCount(c.text(), '[mcp_servers.context7]'), 1);
  assert.equal(c.mcpRows().filter((row) => row.identity === 'context7').length, 1);
  c.checkLedgerVersion();

  const updated = c.ok('update', '-g', '-t', 'codex', '-f');
  assert.doesNotMatch(updated.stdout + updated.stderr, /modified outside DoFlow|kept your own entry/);
  assert.equal(headerCount(c.text(), '[mcp_servers.context7]'), 1);
  assert.equal(c.mcpRows().filter((row) => row.identity === 'context7').length, 1);

  c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.ok(!fs.existsSync(c.config) || !c.text().includes('[mcp_servers.context7]'), 'the table is gone');
  assert.deepEqual(fs.existsSync(c.ledger) ? c.mcpRows() : [], []);
});

test('a row written by 1.20 for a table the user owns is released with --mcp none and the table stays', () => {
  const own = setup('own-row-source');
  own.ok('install', '-g', '-t', 'codex', '--mcp', 'context7', '-f');
  const template = own.mcpRows().find((row) => row.identity === 'context7');
  assert.ok(template, 'a DoFlow-written mcp-server row to copy');

  const c = setup('release');
  c.write(USER_TABLE);
  c.ok('install', '-g', '-t', 'codex', '--mcp', 'context7', '-f');
  const ledger = c.readLedger();
  ledger.resources.push({
    ...template,
    target: c.config,
    fingerprint: fingerprint(renderServer('context7', catalogContext7())),
  });
  fs.writeFileSync(c.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
  const before = c.text();

  const refused = c.doflow('update', '-g', '-t', 'codex', '-f');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /doflow update -g -t codex --mcp none/);
  assert.equal(c.text(), before);

  const released = c.ok('update', '-g', '-t', 'codex', '--mcp', 'none', '-f');
  assert.match(released.stdout, /entry 'context7' in config\.toml was changed outside DoFlow; it is yours now/);
  assert.deepEqual(c.mcpRows().filter((row) => row.identity === 'context7'), []);
  assert.equal(c.text(), before);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();

  c.ok('update', '-g', '-t', 'codex', '-f');
  assert.equal(c.text(), before);
  c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.equal(c.text(), USER_TABLE, 'DoFlow\'s own [features] entry goes and the user\'s table is left as written');
});

test('an empty [features] header gets hooks = true under it and remove restores the file', { skip: NO_TOMLLIB }, () => {
  const c = setup('features-header');
  c.write('[features]\n');
  c.ok('install', '-g', '-t', 'codex', '-f');
  assert.equal(headerCount(c.text(), '[features]'), 1);
  const parsed = parseToml(c.config);
  assert.equal(parsed.features.hooks, true);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();
  c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.equal(c.text(), '[features]\n');
});

test('a root dotted features entry is extended with a dotted hooks key and remove restores the file', { skip: NO_TOMLLIB }, () => {
  const c = setup('features-dotted');
  c.write('features.x = 1\n');
  c.ok('install', '-g', '-t', 'codex', '-f');
  const parsed = parseToml(c.config);
  assert.equal(parsed.features.x, 1);
  assert.equal(parsed.features.hooks, true);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();
  c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.equal(c.text(), 'features.x = 1\n');
});

test('a user [features] table keeps its own keys beside hooks = true', { skip: NO_TOMLLIB }, () => {
  const c = setup('features-table');
  c.write('[features]\nmine = true\n');
  c.ok('install', '-g', '-t', 'codex', '-f');
  const parsed = parseToml(c.config);
  assert.equal(parsed.features.mine, true);
  assert.equal(parsed.features.hooks, true);
  assert.equal(headerCount(c.text(), '[features]'), 1);
  assert.equal(c.mode(), 0o600);
  c.checkLedgerVersion();
  c.ok('remove', '-g', '-t', 'codex', '-f');
  assert.ok(c.text().includes('mine = true'), 'the user\'s key stays after remove');
  assert.ok(!/hooks/.test(c.text()), 'the managed key is gone');
  assert.equal(headerCount(c.text(), '[features]'), 1);
});

test('features set as an inline table is refused and nothing is written', () => {
  const c = setup('features-inline');
  const original = 'features = { x = 1 }\n';
  c.write(original);
  const r = c.doflow('install', '-g', '-t', 'codex', '-f');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is set as a value/);
  assert.equal(c.text(), original);
  assert.equal(c.mode(), 0o600);
  assert.ok(!fs.existsSync(path.join(c.scratch.home, '.doflow', 'backups')), 'no backup directory was created');
});
