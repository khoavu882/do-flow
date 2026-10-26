'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The `slot` verb's argument checks and output forms (feature 115, IC-008). The queue itself is
 * `./slots.ts`; this file only maps flags to it and its results to exit codes.
 */

const { runSlot, listSlots, peekSlots, releaseSlot } = require('./slots.ts');
const { finishRuntime } = require('./cli-result.ts');

const TIMEOUT_MAX = 86400;

function refuse(message: string, json: boolean): number {
  if (json) console.log(JSON.stringify({ ok: false, error: 'usage', message }));
  else console.error(`doflow slot: ${message}`);
  return finishRuntime(2);
}

async function handleSlotCommand({
  action, name, label, timeout, noWait = false, command, by, reason, positional = [], extraFlags = [], json = false, env = process.env, cwd = process.cwd(),
}: any = {}): Promise<number> {
  const usage = 'usage: slot --action run|list|peek|release (see doflow --help)';
  if (extraFlags.length > 0) return refuse(`unknown flag '${extraFlags[0]}'; ${usage}`, json);
  if (positional.length > 0) return refuse(`unexpected argument '${positional[0]}'; ${usage}`, json);
  if (action !== 'run' && action !== 'list' && action !== 'peek' && action !== 'release') return refuse(`--action must be run, list, peek or release; ${usage}`, json);
  try {
    if (action === 'run') {
      if (!Array.isArray(command)) return refuse('slot run needs the command after --, as in: slot --action run --name <name> -- <command> [args...]', json);
      let timeoutSeconds: number | undefined;
      if (timeout !== undefined) {
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT_MAX) return refuse(`--timeout must be a whole number of seconds from 1 to ${TIMEOUT_MAX}`, json);
        timeoutSeconds = timeout;
      }
      return finishRuntime(await runSlot({ name, command, label, timeoutSeconds, noWait, cwd, env }));
    }
    if (action === 'list') {
      const listed = await listSlots({ env, json });
      console.log(listed.output);
      return finishRuntime(0);
    }
    if (action === 'peek') {
      // 093 IC-018 b: a read with no lock, sweep or mkdir; no pid, start or cwd in either form.
      const peeked = await peekSlots({ env, cwd });
      if (json) console.log(JSON.stringify(peeked));
      else if (peeked.slots.length === 0) console.log('no slots held');
      else {
        for (const slot of peeked.slots) {
          const head = slot.holder
            ? `held (${slot.holder.label}) since ${slot.holder.since}, alive ${slot.holder.alive}${slot.holder.worktreeKey ? `, checkout ${slot.holder.worktreeKey}` : ', another directory'}`
            : 'free';
          console.log(`${slot.name}  ${head}; ${slot.waiters} waiting`);
        }
      }
      if (!json && peeked.unreadable > 0) console.log(`unreadable: ${peeked.unreadable}`);
      return finishRuntime(0);
    }
    const released = await releaseSlot({ name, by, reason, env });
    if (json) console.log(JSON.stringify(released));
    else {
      const held = released.holder ? ` (holder ${released.holder.pid}, ${released.holder.label})` : '';
      const line = `slot ${name}: ${released.disposition}${held}`;
      if (released.ok) console.log(line); else console.error(line);
    }
    return finishRuntime(released.ok ? 0 : 1);
  } catch (error: any) {
    if (error.code === 'usage') return refuse(error.message, json);
    if (error.code === 'no-home' || error.code === 'slots-unsafe') {
      if (json) console.log(JSON.stringify({ ok: false, error: error.code, message: error.message }));
      else console.error(`doflow slot: ${error.message}`);
      return finishRuntime(1);
    }
    throw error;
  }
}

module.exports = { handleSlotCommand };
