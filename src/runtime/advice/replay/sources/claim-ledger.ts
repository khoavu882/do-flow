'use strict';

// The `claim-ledger` case source (175 IC-002). The recorded decisions are the claim ledgers of the project's
// `task-evidence` store: a claim linked to evidence as `supports` or `contradicts` is a pair the user's own work settled.
// One case per (claim, linked evidence id): the state is the claim-support state of that pair, the label and the rule are
// both the recorded relation (supports -> yes, contradicts -> no), so `labelIsRule` is true and the source only measures.
//
// Read-only: the files go through the existing loaders (`ClaimsManager`, `EvidenceLedger`) in fixed-directory mode, which
// reads and never saves, and only under the store's own folder and the feature folders directly inside it.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadStorageRegistry } = require('../../../storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('../../../storage/roots.ts');
const { ClaimsManager } = require('../../../claims.ts');
const { EvidenceLedger } = require('../../../evidence-ledger.ts');
const { buildClaimSupportState } = require('../../claim-support.ts');
const { REPO_ROOT } = require('../../../../helper/repo-root.ts');

const STORE_ID = 'task-evidence';
const CLAIMS_SUFFIX = '_claims.json';
const RELATIONS: Array<[string, string, string]> = [['supportingEvidence', 'yes', 'supports'], ['contradictingEvidence', 'no', 'contradicts']];

let storeDeclaration: any = null;

/** The declared `task-evidence` store, read once from the package's own storage registry (not through the project's fs). */
function declaredStore(): any {
  if (!storeDeclaration) {
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
    storeDeclaration = registry.stores.find((store: any) => store.id === STORE_ID) || null;
  }
  return storeDeclaration;
}

/** Directory entries, or none when the folder is absent or unreadable. */
function entriesOf(dir: string, fsImpl: any): any[] {
  try { return fsImpl.readdirSync(dir, { withFileTypes: true }).sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return []; }
}

/** Whether `file` is absent (`null`), a regular file (true) or something else (false); a link is never followed. */
function regularFile(file: string, fsImpl: any): boolean | null {
  try { return fsImpl.lstatSync(file).isFile(); } catch { return null; }
}

function caseId(taskId: string, claimId: string, evidenceId: string): string {
  return crypto.createHash('sha256').update(`${taskId}\n${claimId}\n${evidenceId}`).digest('hex').slice(0, 16);
}

function build({ projectRoot, roots, kind, fsImpl = nodeFs }: any = {}): { cases: any[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const store = declaredStore();
  const resolvedRoots = roots || resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot });
  const storeDir = store ? resolveStorePath({ store, roots: resolvedRoots, fsImpl }) : null;
  if (!storeDir) return { cases: [], skipped };

  // The store folder itself (records written before feature namespaces) and every feature folder directly inside it.
  const folders = [storeDir, ...entriesOf(storeDir, fsImpl).filter((entry: any) => entry.isDirectory()).map((entry: any) => path.join(storeDir, entry.name))];
  const found: any[] = [];
  for (const dir of folders) {
    for (const entry of entriesOf(dir, fsImpl)) {
      if (!entry.isFile() || !entry.name.endsWith(CLAIMS_SUFFIX)) continue;
      const taskId = entry.name.slice(0, -CLAIMS_SUFFIX.length);
      let claims: any[];
      let ledger: any;
      try {
        // An evidence file that is present must be a regular file; an absent one is an empty ledger.
        if (regularFile(path.join(dir, `${taskId}.json`), fsImpl) === false) throw new Error('evidence file is not a regular file');
        const manager = new ClaimsManager({ stateDir: dir, fsImpl });
        manager.load(taskId);
        claims = manager.getClaims();
        ledger = new EvidenceLedger({ stateDir: dir, fsImpl });
        ledger.load(taskId);
      } catch {
        skip('unreadable-file');
        continue;
      }
      for (const claim of claims) {
        for (const [field, label] of RELATIONS) {
          for (const evidenceId of Array.isArray(claim[field]) ? claim[field] : []) {
            const evidence = typeof evidenceId === 'string' ? ledger.getEvidence(evidenceId) : null;
            if (!evidence) { skip('missing-evidence'); continue; }
            const built = buildClaimSupportState({ claim: claim.statement, passage: evidence.content, params: kind?.params });
            if (!built.ok) { skip(built.reason); continue; }
            found.push({ id: caseId(taskId, claim.id, evidenceId), state: built.state, label, rule: label });
          }
        }
      }
    }
  }

  // One id names one (task, claim, evidence) pair; an id reached twice (the same record copied into two folders, or one
  // pair linked both ways) would be counted twice, so every occurrence is left out and counted.
  const seen = new Map<string, number>();
  for (const c of found) seen.set(c.id, (seen.get(c.id) || 0) + 1);
  const cases: any[] = [];
  for (const c of found) {
    if (seen.get(c.id) === 1) cases.push(c);
    else skip('duplicate-case');
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, skipped };
}

const source = { id: 'claim-ledger', builderVersion: 1, labelIsRule: true, origin: 'project', build };

module.exports = { source, build };
