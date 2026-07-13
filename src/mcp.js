'use strict';
// mcp.js — selectable MCP server install, written to Claude Code's REAL config locations (not a
// generic mappings.conf copy target — .mcp.json under .claude/ is never read by Claude Code):
//   global (-g)   -> ~/.claude.json's top-level `mcpServers` key
//   project scope -> <projectRoot>/.mcp.json (sibling to .claude/, the project-root convention
//                    Claude Code actually auto-discovers)
// Both are read-merge-write, never a wholesale overwrite: only the server names doflow itself
// ships in core/.mcp.json are added/removed. Any server the user (or another tool) registered
// under a name doflow doesn't know about — in either file — is left completely untouched. This
// matters more for ~/.claude.json (also holds history/projects/credentials-adjacent state), but a
// project's own .mcp.json can just as easily carry a hand-added server doflow must not clobber.
const fs = require('node:fs');
const path = require('node:path');
const { readSyncBlocking } = require('./prompt');

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** @returns {string[]} server names in core/.mcp.json's mcpServers key order */
function readAllServers(mcpJsonSrcPath) {
  const parsed = JSON.parse(fs.readFileSync(mcpJsonSrcPath, 'utf8'));
  return Object.keys(parsed.mcpServers || {});
}

/** @returns {{[name:string]: object}} only the selected server definitions, source key order */
function filterServerDefs(mcpJsonSrcPath, allServers, selected) {
  const parsed = JSON.parse(fs.readFileSync(mcpJsonSrcPath, 'utf8'));
  const out = {};
  for (const name of allServers) {
    if (selected.includes(name)) out[name] = parsed.mcpServers[name];
  }
  return out;
}

/**
 * Merge selected server defs into an existing mcpServers object, touching only the names doflow
 * ships (`knownServerNames`). A known name not present in `serverDefs` (deselected) is removed;
 * every other key — including a server under a name doflow doesn't recognize — passes through.
 */
function mergeKnownServers(existingMcpServers, knownServerNames, serverDefs) {
  const merged = { ...existingMcpServers };
  for (const name of knownServerNames) {
    if (name in serverDefs) merged[name] = serverDefs[name];
    else delete merged[name];
  }
  return merged;
}

/**
 * Read a JSON file doflow does not fully own, refusing to proceed if it exists but fails to
 * parse — silently treating a malformed file as empty would mean the next write discards
 * whatever unrelated content it held. Failing loudly costs the user one retry after fixing the
 * file; failing silently costs them data with no recovery path (this path isn't backed up).
 */
function readJsonOrThrow(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Refusing to touch malformed ${file} (${e.message}) — fix or remove it, then retry. doflow merges into this file and will not risk overwriting content it can't parse.`);
  }
}

/**
 * Project scope: read-merge-write <projectRoot>/.mcp.json, same "known keys only" semantics as
 * mergeGlobalMcpServers — a hand-added project MCP server doflow doesn't ship must survive.
 * @returns {string} the path written
 */
function writeProjectMcpJson(projectRoot, knownServerNames, serverDefs) {
  const dest = path.join(projectRoot, '.mcp.json');
  const data = readJsonOrThrow(dest);
  data.mcpServers = mergeKnownServers(data.mcpServers || {}, knownServerNames, serverDefs);
  fs.writeFileSync(dest, `${JSON.stringify(data, null, 2)}\n`);
  return dest;
}

/**
 * Global scope: ~/.claude.json is a shared, multi-purpose state file (history, projects,
 * credentials-adjacent references) doflow does not own — read-merge-write, touching only the
 * `mcpServers` keys that match a name doflow itself ships in core/.mcp.json. Every other key in
 * the file, including any MCP server the user registered themselves via `claude mcp add`, is left
 * untouched.
 * @returns {string} the path written
 */
function mergeGlobalMcpServers(homeDir, knownServerNames, serverDefs) {
  const file = path.join(homeDir, '.claude.json');
  const data = readJsonOrThrow(file);
  data.mcpServers = mergeKnownServers(data.mcpServers || {}, knownServerNames, serverDefs);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.claude-${process.pid}-${Date.now()}.json.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Decide which MCP servers to install, in precedence order:
 *   1. --mcp <list>          — explicit, always wins, always persisted
 *   2. interactive checkbox  — install only, real TTY, no --force/--dry-run
 *   3. remembered manifest   — update (or a forced/non-interactive install) reuses the last pick
 *   4. all servers           — first-ever install, nothing else applies
 * `promptFn` is injected so this stays unit-testable without a real TTY.
 * @param {{cmd:string, requested:string[]|null, allServers:string[], manifestServers:string[]|null,
 *           interactive:boolean, promptFn:(servers:string[], seed:string[])=>string[]|null}} p
 * @returns {string[]}
 */
function resolveMcpSelection({ cmd, requested, allServers, manifestServers, interactive, promptFn }) {
  if (requested) {
    if (requested.length === 0) {
      throw new Error('--mcp requires at least one server (omit the flag entirely to keep all)');
    }
    const invalid = requested.filter((s) => !allServers.includes(s));
    if (invalid.length) {
      throw new Error(`Unknown MCP server(s): ${invalid.join(', ')} (valid: ${allServers.join(', ')})`);
    }
    return [...new Set(requested)];
  }
  if (cmd === 'install' && interactive) {
    const seed = manifestServers ?? allServers;
    const picked = promptFn(allServers, seed);
    if (picked !== null) return picked; // [] is a deliberate "no servers" choice, honored as-is
  }
  return manifestServers ?? allServers;
}

const KEY = {
  UP: `${ESC}[A`,
  DOWN: `${ESC}[B`,
  SPACE: ' ',
  ENTER_CR: '\r',
  ENTER_LF: '\n',
  CTRL_C,
  ALL: 'a',
};

/**
 * Block for one raw-mode keypress, via prompt.js's readSyncBlocking (retries the EAGAIN-while-TTY
 * case, bounded by a deadline for a genuinely unusable fd).
 * @returns {string|null} the decoded chunk, or null if the fd is unusable
 */
function readKeypress(buf) {
  try {
    const n = readSyncBlocking(0, buf);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  }
}

/**
 * Synchronous raw-mode checkbox prompt (arrow keys / j-k to move, space to toggle, 'a' to
 * toggle-all, enter to confirm). Matches src/prompt.js's synchronous-read style — this CLI has no
 * async control flow to hang off, so a real TTY read loop is built directly on fs.readSync(0, ...),
 * the same primitive confirm()/promptLine() already use.
 * @returns {string[]|null} selected server names, or null if no usable TTY (caller falls back)
 */
function promptMcpCheckbox(servers, initialSelected, message = 'Select MCP servers to install:') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (servers.length === 0) return [];

  const selected = new Set(initialSelected);
  let cursor = 0;
  const help = '  (up/down or j/k move, space toggle, a toggle-all, enter confirm)';

  const render = (first) => {
    if (!first) process.stdout.write(`${ESC}[${servers.length + 2}A`);
    console.log(message);
    console.log(help);
    for (let i = 0; i < servers.length; i++) {
      const mark = selected.has(servers[i]) ? '[x]' : '[ ]';
      const pointer = i === cursor ? '>' : ' ';
      console.log(`${pointer} ${mark} ${servers[i]}`);
    }
  };

  let wasRaw = false;
  let aborted = false;
  try {
    wasRaw = Boolean(process.stdin.isRaw);
    process.stdin.setRawMode(true);
    render(true);
    const buf = Buffer.alloc(16);
    for (;;) {
      const chunk = readKeypress(buf);
      if (chunk === null) {
        aborted = true;
        break;
      }
      if (chunk === KEY.ENTER_CR || chunk === KEY.ENTER_LF) break;
      if (chunk === KEY.CTRL_C) {
        console.log('\n[INFO]  Aborted.');
        process.exit(130);
      }
      if (chunk === KEY.UP || chunk === 'k') cursor = (cursor - 1 + servers.length) % servers.length;
      else if (chunk === KEY.DOWN || chunk === 'j') cursor = (cursor + 1) % servers.length;
      else if (chunk === KEY.SPACE) {
        const s = servers[cursor];
        if (selected.has(s)) selected.delete(s);
        else selected.add(s);
      } else if (chunk === KEY.ALL) {
        if (selected.size === servers.length) selected.clear();
        else for (const s of servers) selected.add(s);
      }
      render(false);
    }
  } finally {
    process.stdin.setRawMode(wasRaw);
  }
  console.log('');
  if (aborted) return null; // fd went unusable mid-prompt — caller falls back to manifest/all
  return servers.filter((s) => selected.has(s));
}

module.exports = {
  readAllServers,
  filterServerDefs,
  writeProjectMcpJson,
  mergeGlobalMcpServers,
  resolveMcpSelection,
  promptMcpCheckbox,
};
