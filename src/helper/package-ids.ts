'use strict';

// Package, local, qualified and projected identifiers (122 IC-003, PN-3). Pure and dependency-free so
// `src/registry/` (row 120's worker ids) and `src/runtime/` import the one definition.

const PACKAGE_ID = /^[a-z][a-z0-9-]{0,14}[a-z0-9]$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,13}[a-z0-9]$/;
const QUALIFIED_MAX = 32;
// Refused as a package id (reserved-id); `doflow` is usable only by the bundled first-party package.
const RESERVED = ['doflow', 'do', 'core', 'user', 'project', 'local', 'env', 'auto', 'package', 'packages'];

const isPackageId = (value: any): boolean => typeof value === 'string' && PACKAGE_ID.test(value) && !value.includes('--');
const isLocalId = (value: any): boolean => typeof value === 'string' && LOCAL_ID.test(value) && !value.includes('--');

/** True for a package id the grammar accepts but IC-003 reserves: the listed names and any `do-` or `doflow-` prefix. */
function isReservedPackageId(value: any): boolean {
  return typeof value === 'string' && (RESERVED.includes(value) || value.startsWith('do-') || value.startsWith('doflow-'));
}

function isQualifiedId(value: any): boolean {
  if (typeof value !== 'string' || value.length > QUALIFIED_MAX) return false;
  const parts = value.split('.');
  return parts.length === 2 && isPackageId(parts[0]) && isLocalId(parts[1]);
}

/** `<package id>.<local id>`, or null when either part breaks its grammar. */
function qualifiedId(packageId: string, localId: string): string | null {
  const joined = `${packageId}.${localId}`;
  return isPackageId(packageId) && isLocalId(localId) && joined.length <= QUALIFIED_MAX ? joined : null;
}

/** The harness-file name of a qualified id, `<package id>-<local id>`; null when the input is not a qualified id. */
function projectedName(qualified: string): string | null {
  return isQualifiedId(qualified) ? qualified.replace('.', '-') : null;
}

module.exports = { isPackageId, isLocalId, isQualifiedId, isReservedPackageId, qualifiedId, projectedName };
