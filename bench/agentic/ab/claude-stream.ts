'use strict';

/**
 * Claude headless transcript parser for the with/without-DoFlow A/B benchmark (WP-1).
 *
 * Input: stdout of `claude -p --output-format stream-json --verbose --include-hook-events`, one line at
 * a time. Output: one `ClaudeRunReport` per run. Bench-local on purpose (decision D2): the production
 * parser table (`src/runtime/worker/parsers.ts`) has a fixed `Report` shape (`usage: {tokens}`, no events)
 * that the supervisor consumes, and a richer report would change that contract. This file shares the
 * line-feed interface (`line`, `oversize`, `end`) so a later registry entry can wrap it.
 *
 * Source vs inference (field notes):
 *   - SOURCE, observed on claude 2.1.308 with an unreachable endpoint (no model call): the `system/init`
 *     keys (`session_id`, `model`, `permissionMode`, `tools`, `skills`, `agents`, `slash_commands`,
 *     `mcp_servers`, `plugins`, `apiKeySource`, `claude_code_version`), `system/hook_started` and
 *     `system/hook_response` (with `--include-hook-events`), `system/api_retry`.
 *   - SOURCE, code.claude.com Agent SDK docs: the `result` event (`subtype`, `is_error`, `result`,
 *     `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `stop_reason`, `terminal_reason`,
 *     `permission_denials`), `tool_use` blocks, the subagent tool is named `Agent` in `tool_use` and `Task`
 *     in the init tool list, `parent_tool_use_id` on messages inside a subagent. `usage` excludes
 *     subagents; `modelUsage` and `total_cost_usd` include them.
 *   - INFERRED: `outsideMainLoop` (whole tree minus main loop) assumes both come from the same result.
 *     `AskUserQuestion` is not in the init tool list in `-p` runs without a permission host (SOURCE:
 *     docs/hooks "Tools that require user interaction"), so a pause shows mostly as `finalTextAsks`.
 *
 * No I/O, no state outside one parser instance. Free text is masked before it is kept.
 */

const { maskLine, maskBody } = require('../../../src/runtime/mask.ts');

const CLAUDE_STREAM_JSON_V1 = 'claude-stream-json-v1';
const COMMAND_CHARS = 300;
const PATH_CHARS = 300;
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const SKILL_FILE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/;

type Tokens = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
type ModelRow = Tokens & { costUSD: number | null };
type ToolCall = { id: string | null; name: string; parentToolUseId: string | null; target: string | null };
type SkillEvent = { via: 'skill-tool' | 'read'; skill: string; path: string | null; toolUseId: string | null };
type HookEvent = { event: string; name: string; outcome: string | null; exitCode: number | null };
type Init = {
  sessionId: string | null; model: string | null; permissionMode: string | null; claudeCodeVersion: string | null;
  apiKeySource: string | null; cwd: string | null; tools: string[]; skills: string[]; agents: string[];
  slashCommands: string[]; mcpServers: unknown[]; plugins: string[];
};
type ClaudeRunReport = {
  parser: typeof CLAUDE_STREAM_JSON_V1;
  status: 'success' | 'failure' | 'unparsed';
  reason: string | null;
  finalText: string | null;
  sessionId: string | null;
  resultSubtype: string | null;
  isError: boolean | null;
  stopReason: string | null;
  terminalReason: string | null;
  apiErrorStatus: number | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  totalCostUsd: number | null;
  usage: Tokens | null;
  modelUsage: Record<string, ModelRow>;
  models: string[];
  wholeTree: Tokens | null;
  outsideMainLoop: Tokens | null;
  init: Init | null;
  hooks: HookEvent[];
  toolCalls: ToolCall[];
  toolCounts: Record<string, number>;
  subagentCalls: { id: string | null; subagentType: string | null }[];
  skillEvents: SkillEvent[];
  questions: { askUserQuestion: number; finalTextAsks: boolean; any: boolean };
  permissionDenials: number;
  apiRetries: number;
  resultCount: number;
  ignoredLines: number;
};

const ZERO: Tokens = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function tokensOf(raw: any): Tokens | null {
  if (raw === null || typeof raw !== 'object') return null;
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = count(raw[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const input = read('inputTokens', 'input_tokens');
  const output = read('outputTokens', 'output_tokens');
  const creation = read('cacheCreationInputTokens', 'cache_creation_input_tokens');
  const cacheRead = read('cacheReadInputTokens', 'cache_read_input_tokens');
  if (input === null && output === null && creation === null && cacheRead === null) return null;
  return {
    inputTokens: input ?? 0, outputTokens: output ?? 0,
    cacheCreationInputTokens: creation ?? 0, cacheReadInputTokens: cacheRead ?? 0,
  };
}

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function subtractFloor(a: Tokens, b: Tokens): Tokens {
  const cut = (x: number, y: number) => Math.max(0, x - y);
  return {
    inputTokens: cut(a.inputTokens, b.inputTokens),
    outputTokens: cut(a.outputTokens, b.outputTokens),
    cacheCreationInputTokens: cut(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheReadInputTokens: cut(a.cacheReadInputTokens, b.cacheReadInputTokens),
  };
}

/** Total tokens in the unit the A/B plan caps on: input + cache creation + cache read + output. */
function totalTokens(tokens: Tokens | null): number {
  return tokens === null
    ? 0
    : tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}

function eventOf(text: string): any {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.type === 'string' ? value : null;
}

/**
 * True when the last non-empty paragraph of `text` ends in a question mark, ignoring trailing markdown
 * emphasis, quotes, brackets and whitespace. The raw text stays in the report for audit.
 */
function endsAsking(text: string | null): boolean {
  if (!text) return false;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return false;
  const last = paragraphs[paragraphs.length - 1].replace(/[\s*_`"'”’)\]>]+$/u, '');
  return last.endsWith('?');
}

function createClaudeStreamJsonV1() {
  let init: Init | null = null;
  let result: any = null;
  let resultCount = 0;
  let ignoredLines = 0;
  let oversizeJson = false;
  let apiRetries = 0;
  const hooks: HookEvent[] = [];
  const toolCalls: ToolCall[] = [];
  const subagentCalls: { id: string | null; subagentType: string | null }[] = [];
  const skillEvents: SkillEvent[] = [];
  let askUserQuestion = 0;
  let lastAssistantText: string | null = null;
  const hookNames = new Map<string, string>();

  function toolUse(block: any, parentToolUseId: string | null): void {
    const name = String(block.name);
    const input = block.input !== null && typeof block.input === 'object' ? block.input : {};
    const id = typeof block.id === 'string' ? block.id : null;
    let target: string | null = null;
    if (name === 'Bash' && typeof input.command === 'string') target = maskLine(input.command).text.slice(0, COMMAND_CHARS);
    else if (typeof input.file_path === 'string') target = maskLine(input.file_path).text.slice(0, PATH_CHARS);
    else if (name === 'Skill' && typeof input.skill === 'string') target = input.skill;
    toolCalls.push({ id, name, parentToolUseId, target });

    if (name === 'AskUserQuestion') askUserQuestion++;
    if (SUBAGENT_TOOL_NAMES.has(name)) {
      subagentCalls.push({ id, subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null });
    }
    if (name === 'Skill' && typeof input.skill === 'string') {
      skillEvents.push({ via: 'skill-tool', skill: input.skill, path: null, toolUseId: id });
    } else if (name === 'Read' && typeof input.file_path === 'string') {
      const match = SKILL_FILE.exec(input.file_path);
      if (match) skillEvents.push({ via: 'read', skill: match[1], path: maskLine(input.file_path).text.slice(0, PATH_CHARS), toolUseId: id });
    }
  }

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      const event = eventOf(String(text ?? '').replace(/\r$/, ''));
      if (!event) { ignoredLines++; return; }

      if (event.type === 'system' && event.subtype === 'init') {
        init = {
          sessionId: typeof event.session_id === 'string' ? event.session_id : null,
          model: typeof event.model === 'string' ? event.model : null,
          permissionMode: typeof event.permissionMode === 'string' ? event.permissionMode : null,
          claudeCodeVersion: typeof event.claude_code_version === 'string' ? event.claude_code_version : null,
          apiKeySource: typeof event.apiKeySource === 'string' ? event.apiKeySource : null,
          cwd: typeof event.cwd === 'string' ? event.cwd : null,
          tools: strings(event.tools),
          skills: strings(event.skills),
          agents: strings(event.agents),
          slashCommands: strings(event.slash_commands),
          mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
          plugins: Array.isArray(event.plugins)
            ? event.plugins.map((p: any) => (typeof p?.name === 'string' ? p.name : null)).filter((p: string | null) => p !== null)
            : [],
        };
      } else if (event.type === 'system' && event.subtype === 'hook_started' && typeof event.hook_id === 'string') {
        hookNames.set(event.hook_id, typeof event.hook_name === 'string' ? event.hook_name : '');
      } else if (event.type === 'system' && event.subtype === 'hook_response') {
        hooks.push({
          event: typeof event.hook_event === 'string' ? event.hook_event : '',
          name: typeof event.hook_name === 'string' ? event.hook_name : hookNames.get(event.hook_id) ?? '',
          outcome: typeof event.outcome === 'string' ? event.outcome : null,
          exitCode: Number.isInteger(event.exit_code) ? event.exit_code : null,
        });
      } else if (event.type === 'system' && event.subtype === 'api_retry') {
        apiRetries++;
      } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        const parent = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null;
        for (const block of event.message.content) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') toolUse(block, parent);
          else if (block?.type === 'text' && typeof block.text === 'string' && parent === null) lastAssistantText = block.text;
        }
      } else if (event.type === 'result') {
        result = event;
        resultCount++;
      } else if (!(event.type === 'system' || event.type === 'user' || event.type === 'stream_event' || event.type === 'rate_limit_event')) {
        ignoredLines++;
      }
    },
    end(): ClaudeRunReport {
      const usage = tokensOf(result?.usage);
      const modelUsage: Record<string, ModelRow> = {};
      let wholeTree: Tokens | null = null;
      if (result?.modelUsage !== null && typeof result?.modelUsage === 'object') {
        for (const [model, raw] of Object.entries<any>(result.modelUsage)) {
          const row = tokensOf(raw);
          if (row === null) continue;
          modelUsage[model] = { ...row, costUSD: count(raw?.costUSD) };
          wholeTree = addTokens(wholeTree ?? ZERO, row);
        }
      }
      const outsideMainLoop = wholeTree !== null && usage !== null ? subtractFloor(wholeTree, usage) : null;

      const resultText = typeof result?.result === 'string' ? result.result : null;
      const rawFinal = resultText !== null && resultText !== '' ? resultText : lastAssistantText;
      const finalText = rawFinal === null ? null : maskBody(rawFinal).text;

      let status: ClaudeRunReport['status'];
      let reason: string | null = null;
      if (result === null) {
        status = 'unparsed';
        reason = oversizeJson ? 'oversize-line' : 'no-result-event';
      } else if (result.subtype !== 'success') {
        status = 'failure';
        reason = typeof result.subtype === 'string' ? result.subtype : 'unknown-subtype';
      } else if (result.is_error === true) {
        status = 'failure';
        reason = Number.isInteger(result.api_error_status) ? `api-error-${result.api_error_status}` : (typeof result.stop_reason === 'string' ? result.stop_reason : 'is-error');
      } else {
        status = 'success';
      }

      const toolCounts: Record<string, number> = {};
      for (const call of toolCalls) toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
      const finalTextAsks = endsAsking(finalText);

      return {
        parser: CLAUDE_STREAM_JSON_V1,
        status,
        reason,
        finalText,
        sessionId: typeof result?.session_id === 'string' ? result.session_id : init?.sessionId ?? null,
        resultSubtype: typeof result?.subtype === 'string' ? result.subtype : null,
        isError: typeof result?.is_error === 'boolean' ? result.is_error : null,
        stopReason: typeof result?.stop_reason === 'string' ? result.stop_reason : null,
        terminalReason: typeof result?.terminal_reason === 'string' ? result.terminal_reason : null,
        apiErrorStatus: Number.isInteger(result?.api_error_status) ? result.api_error_status : null,
        numTurns: count(result?.num_turns),
        durationMs: count(result?.duration_ms),
        durationApiMs: count(result?.duration_api_ms),
        totalCostUsd: count(result?.total_cost_usd),
        usage,
        modelUsage,
        models: Object.keys(modelUsage),
        wholeTree,
        outsideMainLoop,
        init,
        hooks: hooks.slice(),
        toolCalls: toolCalls.slice(),
        toolCounts,
        subagentCalls: subagentCalls.slice(),
        skillEvents: skillEvents.slice(),
        questions: { askUserQuestion, finalTextAsks, any: askUserQuestion > 0 || finalTextAsks },
        permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
        apiRetries,
        resultCount,
        ignoredLines,
      };
    },
  };
}

/**
 * Proof that DoFlow was loaded (plan section 3, P2/P3), from one report. `expected` names what the
 * projection must have put in the session; a name missing from the init lists is reported, not guessed.
 * `loaded` needs every expected skill and agent in `init` AND a successful SessionStart hook response.
 * `absent` (arm A) needs none of the expected names in the skill/agent/command lists.
 */
function loadProof(report: ClaudeRunReport, expected: { skills: string[]; agents: string[] }) {
  const init = report.init;
  const have = {
    skills: new Set([...(init?.skills ?? []), ...(init?.slashCommands ?? [])]),
    agents: new Set(init?.agents ?? []),
  };
  const missingSkills = expected.skills.filter((n) => !have.skills.has(n));
  const missingAgents = expected.agents.filter((n) => !have.agents.has(n));
  const presentSkills = expected.skills.filter((n) => have.skills.has(n));
  const presentAgents = expected.agents.filter((n) => have.agents.has(n));
  const sessionStartOk = report.hooks.some((h) => h.event === 'SessionStart' && h.outcome === 'success' && h.exitCode === 0);
  return {
    initSeen: init !== null,
    missingSkills, missingAgents, presentSkills, presentAgents,
    sessionStartOk,
    loaded: init !== null && missingSkills.length === 0 && missingAgents.length === 0 && sessionStartOk,
    absent: init !== null && presentSkills.length === 0 && presentAgents.length === 0 && report.hooks.length === 0,
  };
}

/** Parses a whole stream-json transcript string (convenience for graders and tests). */
function parseTranscript(text: string): ClaudeRunReport {
  const parser = createClaudeStreamJsonV1();
  for (const line of String(text).split('\n')) if (line.trim() !== '') parser.line(line);
  return parser.end();
}

module.exports = {
  CLAUDE_STREAM_JSON_V1,
  create: createClaudeStreamJsonV1,
  parseTranscript,
  loadProof,
  totalTokens,
  endsAsking,
};
