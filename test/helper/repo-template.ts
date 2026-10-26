'use strict';

// A git repository built once per test process and copied for each test (maint-testdiet).
//
// A test that needs "a repository with one base commit" used to run `git init`, three `git config`
// calls, `git add` and `git commit` for every case. `repoFromTemplate(key, dest, build)` runs `build`
// once per `key` in a scratch folder and then copies that folder to `dest` with the file system alone,
// so the second and later cases spawn nothing for the base. The copy is a plain directory copy, not a
// `git clone --shared`: a clone adds an `origin` remote and remote-tracking refs and leaves an
// alternates link to the template, which a test about remotes or about the repository's own refs would
// read. A copy is byte-identical, so the commit ids a fixed author, committer and date produce are the
// same in every case.
//
// Use it only for state that no test mutates before it copies: `build` must be deterministic in `key`,
// and it must not record the template's own path in the repository (no worktree, no absolute path in
// the config). Add worktrees and branches after the copy, in `dest`.

const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('./tmp.ts');

const BUILT = new Map();

/**
 * Copies the template for `key` to `dest` (an absolute path), building the
 * template first when this process has not. Returns what `build` returned, so a caller can read the
 * values the build computed (commit ids, for one).
 * @param {string} key one entry per distinct repository content
 * @param {string} dest where the case's repository goes (it may already exist, empty)
 * @param {(dir: string) => any} build makes the repository in `dir` (an existing empty folder)
 */
function repoFromTemplate(key: any, dest: any, build: any) {
  let entry = BUILT.get(key);
  if (!entry) {
    const dir = path.join(suiteTempDir('doflow-repo-template-'), 'repo');
    fs.mkdirSync(dir, { recursive: true });
    entry = { dir, result: build(dir) };
    BUILT.set(key, entry);
  }
  fs.cpSync(entry.dir, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  return entry.result;
}

module.exports = { repoFromTemplate };
