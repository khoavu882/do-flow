'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `doflow config validate --prepared-run <file>` (119 IC-010, FR-013, NFR-005). Checks a prepared-run file
 * `{ schema: 1, taskClass, primary: { harness, model }, settings: { <key>: <value> }, presets: { review, debate } }`
 * and returns one IC-009 entry per fault, keyed by JSON path. It starts no harness, calls no model, runs no git,
 * opens no network connection and writes nothing. Each `settings` and `primary` entry is judged exactly as
 * `config validate <key> <value> --layer project` (config-write.ts `keyEntry` + `layerEntry`), so no value
 * rule is repeated here. The presets
 * are checked against what a run can know before there is a diff (L-E1): the risk-policy step of the protocol
 * resolution needs the diff and is not applied.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { keyEntry, layerFile, layerEntry } = require('./config-write.ts');
const { loadProtocols, presetIds, contributedPresetIds } = require('../review/protocols.ts');
const { gateMinSeats, settingsPick, atLeastAsStrict } = require('../review/resolve-protocol.ts');

/** The worker fields are judged here, without applying them or launching a harness. */
const KNOWN = new Set(['schema', 'taskClass', 'primary', 'workers', 'settings', 'presets']);

interface Entry { key: string; layer: string | null; ok: false; code: string; message: string; allowed: unknown }

function entry(key: string, layer: string | null, code: string, message: string, allowed: unknown = null): Entry {
  return { key, layer, ok: false, code, message, allowed };
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** IC-018: qualified worker ids need JSON-path brackets; built-in ids stay readable. */
function bindingKey(id: string, tier: string): string {
  const worker = /^[a-z][a-z0-9-]*$/.test(id) ? `.${id}` : `[${JSON.stringify(id)}]`;
  return `workers.models${worker}.${tier}`;
}

/** The task classes of the workflow registry, the one `doflow classify` validates against. */
function taskClasses(repoRoot: string, fsImpl: any): string[] {
  const { WorkflowEngine } = require('../workflow-engine.ts');
  return new WorkflowEngine({ repoRoot, fsImpl }).listClasses();
}

function validatePrepared(doc: Record<string, any>, ctx: any): Entry[] {
  const { registry, protocols, classes } = ctx;
  const errors: Entry[] = [];
  const notes: string[] = ctx.notes;

  if (!Object.hasOwn(doc, 'schema')) errors.push(entry('schema', null, 'type', 'schema is required and must be 1'));
  else if (doc.schema !== 1) errors.push(entry('schema', null, 'enum', 'schema must be 1', [1]));

  let taskClass: string | null = null;
  if (typeof doc.taskClass !== 'string') {
    errors.push(entry('taskClass', null, 'type', Object.hasOwn(doc, 'taskClass') ? 'taskClass must be a string' : 'taskClass is required'));
  } else if (!classes.includes(doc.taskClass)) {
    errors.push(entry('taskClass', null, 'enum', `${doc.taskClass} is not a task class in core/registry/workflows.yaml`, classes));
  } else taskClass = doc.taskClass;

  const settings: Record<string, any> = isObject(doc.settings) ? doc.settings : {};
  if (Object.hasOwn(doc, 'settings') && !isObject(doc.settings)) errors.push(entry('settings', null, 'type', 'settings must be an object of setting keys to values'));
  let where: any = null;
  for (const key of Object.keys(settings)) {
    const named = (e: Entry): Entry => ({ ...e, key: `settings.${e.key}` });
    const keyFault = keyEntry(registry, key, 'project', true);
    if (keyFault) { errors.push(named(keyFault)); continue; }
    if (settings[key] === null) { errors.push(entry(`settings.${key}`, 'project', 'type', `${key} cannot be null; leave the key out`)); continue; }
    where ??= layerFile('project', ctx.env, ctx.projectRoot, ctx.fsImpl);
    if ('error' in where) throw Object.assign(new Error(where.error), { usage: true });
    const fault = layerEntry(registry, key, 'project', where.file, { ok: true, value: settings[key] },
      { env: ctx.env, projectRoot: ctx.projectRoot, fsImpl: ctx.fsImpl, siblings: settings });
    if (fault) errors.push(named(fault));
  }

  const primary: Record<string, any> = isObject(doc.primary) ? doc.primary : {};
  if (Object.hasOwn(doc, 'primary') && !isObject(doc.primary)) {
    errors.push(entry('primary', null, 'type', 'primary must be an object with harness and model'));
  } else if (Object.hasOwn(doc, 'primary')) {
    for (const field of Object.keys(primary)) {
      const key = `primary.${field}`;
      if (field !== 'harness' && field !== 'model') {
        errors.push(entry(key, null, 'unknown-key', `${field} is not a primary field; expected harness, model`));
        continue;
      }
      const keyFault = keyEntry(registry, key, 'project', true);
      if (keyFault) { errors.push(keyFault); continue; }
      if (primary[field] === null) {
        errors.push(entry(key, 'project', 'type', `${key} cannot be null; leave the key out`));
        continue;
      }
      where ??= layerFile('project', ctx.env, ctx.projectRoot, ctx.fsImpl);
      if ('error' in where) throw Object.assign(new Error(where.error), { usage: true });
      const fault = layerEntry(registry, key, 'project', where.file, { ok: true, value: primary[field] },
        { env: ctx.env, projectRoot: ctx.projectRoot, fsImpl: ctx.fsImpl, siblings: primary });
      if (fault) errors.push(fault);
    }
  }

  if (Object.hasOwn(doc, 'workers')) {
    const { validateValue } = require('./files.ts');
    const workers: Record<string, any> = isObject(doc.workers) ? doc.workers : {};
    if (!isObject(doc.workers)) {
      errors.push(entry('workers', null, 'type', 'workers must be an object with enabled and models'));
    } else {
      for (const field of Object.keys(workers)) {
        if (field !== 'enabled' && field !== 'models') {
          errors.push(entry(`workers.${field}`, null, 'unknown-key', `${field} is not a workers field; expected enabled, models`));
        }
      }

      if (Object.hasOwn(workers, 'enabled')) {
        const key = 'workers.enabled';
        const value = workers.enabled;
        const spec = registry.keys.get(key);
        const allowed = registry.enumValues(key);
        if (value === null) {
          errors.push(entry(key, null, 'type', `${key} cannot be null; leave the key out`));
        } else {
          const fault = validateValue(spec, value, allowed);
          if (fault) {
            let index = -1;
            if (Array.isArray(value)) {
              for (let i = 0; i < value.length; i += 1) {
                if (validateValue(spec, value.slice(0, i + 1), allowed)) { index = i; break; }
              }
            }
            if (index >= 0) {
              const prefixFault = validateValue(spec, value.slice(0, index + 1), allowed);
              errors.push(entry(`${key}[${index}]`, null, prefixFault.code, prefixFault.reason, allowed));
            } else errors.push(entry(key, null, fault.code, fault.reason, allowed));
          } else {
            where ??= layerFile('project', ctx.env, ctx.projectRoot, ctx.fsImpl);
            if ('error' in where) throw Object.assign(new Error(where.error), { usage: true });
            const fault = layerEntry(registry, key, 'project', where.file, { ok: true, value },
              { env: ctx.env, projectRoot: ctx.projectRoot, fsImpl: ctx.fsImpl, notes, siblings: {} });
            if (fault) {
              if (fault.code === 'not-narrower') {
                const match = fault.message.match(/\('([^']*)' is not in the value below\)/);
                const index = match ? value.indexOf(match[1]) : -1;
                if (index >= 0) fault.key = `${key}[${index}]`;
              }
              errors.push(fault);
            }
          }
        }
      }

      if (Object.hasOwn(workers, 'models')) {
        const key = 'workers.models';
        const value = workers.models;
        const spec = registry.keys.get(key);
        const allowed = registry.enumValues(key);
        if (value === null) {
          errors.push(entry(key, null, 'type', `${key} cannot be null; leave the key out`));
        } else {
          const fault = validateValue(spec, value, allowed);
          if (fault) {
            errors.push(entry(key, null, fault.code, fault.reason, allowed));
          } else {
            const { loadRegistry } = require('../../registry/index.ts');
            const { workerCatalogue } = require('../worker/catalogue.ts');
            const workerRegistry = loadRegistry({ repoRoot: ctx.repoRoot, fsImpl: ctx.fsImpl });
            const catalogue = workerCatalogue({ registry: workerRegistry });
            const byId = new Map<string, any>(catalogue.map((worker: any) => [worker.id, worker]));
            for (const id of Object.keys(value)) {
              const worker = byId.get(id);
              if (!worker) {
                notes.push(`note: ${key}: worker '${id}' is not installed (ignored)`);
                continue;
              }
              const status = worker.worker.model?.status || 'absent';
              if (status === 'supported') continue;
              for (const tier of Object.keys(value[id])) {
                errors.push(entry(bindingKey(id, tier), null, 'model-flag-unevidenced',
                  `${id} has no evidenced model flag (descriptor model is ${status}); dispatch would skip the worker for this binding`));
              }
            }
          }
        }
      }
    }
  }

  const presets: Record<string, any> = isObject(doc.presets) ? doc.presets : {};
  if (Object.hasOwn(doc, 'presets') && !isObject(doc.presets)) errors.push(entry('presets', null, 'type', 'presets must be an object with review and debate preset ids'));
  let loaded: any = null; // the start verb's inputs, loaded once and only when a preset is checked
  const inputs = (): any => (loaded ??= ctx.inputs(taskClass));
  for (const kind of ['review', 'debate']) {
    if (!Object.hasOwn(presets, kind)) continue;
    const order: string[] = presetIds(protocols, kind); // the effective core order: the only ids that have a rank
    const named: string[] = [...order, ...contributedPresetIds(protocols, kind)]; // selectable by name (122 IC-014)
    const key = `presets.${kind}`;
    const id = presets[kind];
    if (typeof id !== 'string' || !named.includes(id)) {
      errors.push(entry(key, null, 'enum', `${typeof id === 'string' ? id : JSON.stringify(id)} is not a ${kind} preset`, named));
      continue;
    }
    // The effective preset setting (C-3): the user/project/local layers `review --action start` reads, with this
    // file's own entry as the project layer, applied by the resolver's rule (settingsPick) to the loosest preset.
    const settingKey = `${kind}.preset`;
    const view: Record<string, any> = { ...inputs().settingsView };
    const current = view[settingKey];
    if (typeof settings[settingKey] === 'string' && (!current || ['default', 'user', 'project'].includes(current.layer))) {
      view[settingKey] = { value: settings[settingKey], layer: 'project' };
    }
    const pick = settingsPick({ kind, pick: { id: order[order.length - 1], origin: 'registry' }, settingsView: view, registry: protocols });
    // Two core ids compare by their place in the order; a pair with a contributed id by dominance (never an indexOf of -1).
    if (!atLeastAsStrict(protocols, kind, id, pick.id)) {
      errors.push(entry(key, null, 'not-narrower', `${id} is looser than settings["${settingKey}"] ${pick.id} (${pick.origin} layer)`));
      continue;
    }
    if (kind !== 'review') continue;
    if (taskClass === null) continue;
    // maint-thin: the seat floor binds unless autopilot is verifiably off (reviewUnattended), as in review start.
    const floor: number = inputs().unattended === false ? 0 : gateMinSeats(inputs().gatePolicy, taskClass);
    const seats: number = protocols.presets[id].seats.length;
    if (seats < floor) { // the seat floor (L-E1); the E.1-control-floor mutation targets this line
      errors.push(entry(key, null, 'not-narrower', `${id} has ${seats} seat${seats === 1 ? '' : 's'}; the gate-b floor for ${taskClass} is ${floor} seats`));
    }
  }

  for (const key of Object.keys(doc)) {
    if (KNOWN.has(key)) continue;
    errors.push(entry(key, null, 'unknown-key', `${key} is not a prepared-run field; expected schema, taskClass, primary, workers, settings, presets`));
  }
  return errors;
}

function report(file: string, errors: Entry[], json: boolean, notes: string[] = []): number {
  if (json) console.log(JSON.stringify({ ok: errors.length === 0, errors, ...(notes.length ? { notes } : {}) }, null, 2));
  else {
    if (errors.length === 0) console.log(`prepared run: valid (${file})`);
    else for (const error of errors) console.error(`${error.key}: ${error.message}`);
    for (const note of notes) console.log(note);
  }
  return finishRuntime(errors.length === 0 ? 0 : 1);
}

function handlePreparedRun({ file, json, registry, repoRoot, projectRoot, env, fsImpl = nodeFs }: any): number {
  let text: string;
  try { text = fsImpl.readFileSync(path.resolve(file), 'utf8'); } catch { return usageError('config', `cannot read the prepared run ${file}`, json); }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return report(file, [entry('$', null, 'type', 'the prepared run is not valid JSON')], json); }
  if (!isObject(doc)) return report(file, [entry('$', null, 'type', 'the prepared run must be a JSON object')], json);

  try {
    const protocols = loadProtocols({ repoRoot, fsImpl });
    if (!protocols.ok) throw new Error(protocols.errors.join('; '));
    const root = path.resolve(projectRoot);
    const notes: string[] = [];
    const ctx = {
      registry, protocols: protocols.registry, classes: taskClasses(repoRoot, fsImpl), env, projectRoot: root, repoRoot, fsImpl, notes,
      // what `review --action start` loads: the protocol settings view and gates.json narrowed by the project's override
      inputs: (taskClass: string | null): any => {
        const inputs = require('../review/start.ts').loadProtocolInputs(taskClass, root, env);
        if ('error' in inputs) throw Object.assign(new Error(inputs.message), { usage: true });
        return inputs;
      },
    };
    return report(file, validatePrepared(doc, ctx), json, notes);
  } catch (error: any) {
    return usageError('config', error?.message || String(error), json, error.usage ? undefined : error);
  }
}

module.exports = { handlePreparedRun, bindingKey };
