'use strict';

const path = require('node:path');

/**
 * The package root, resolved once from this file's own location.
 *
 * Eighteen modules used to compute this themselves as `REPO_ROOT`, which
 * silently encodes how deep the computing file sits. Grouping the scaffold, trace and verification
 * modules into directories moved three of them one level down and turned that uniform duplication
 * into two different forms of the same expression — so a later move has to pick the right one, with
 * nothing checking the choice. Every wrong pick resolves to a real directory (`<repo>/src`), so it
 * fails by reading the wrong tree rather than by throwing.
 *
 * Homed in `src/helper/` because the root is not a runtime, install or harness concern: it is the
 * one fact all three layers share. `src/adapters/`, `src/install/` and `src/lifecycle/` already
 * depend on this directory.
 *
 * A constant rather than a function: it cannot vary within a process, and a function invites a
 * caller to pass an argument that would make it vary.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = { REPO_ROOT };
