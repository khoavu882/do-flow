'use strict';
// host-tag.ts — which host and pid namespace a pid recorded in a name belongs to. Shared by the backup
// rename-aside folders (src/install/backup.ts) and the task-state lock's owner entries
// (src/runtime/task-state.ts): both judge a recorded pid only from the host and namespace that issued it.

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * The id of this process's pid namespace where the platform exposes one (Linux: the target of
 * `/proc/self/ns/pid`, such as `pid:[4026531836]`), else the empty string. A pid means something only
 * inside the namespace that issued it; two containers can share a hostname and not a pid space.
 */
function pidNamespaceId(): string {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; }
}

/**
 * Eight hex digits that identify the host and pid namespace in a name. A pid means something only in
 * the namespace it was issued in, so a recorded pid is judged only by a process in the same namespace
 * on the same host. Where no namespace id exists the tag is the hostname alone.
 */
function hostTag(hostname: string = os.hostname(), pidNamespace: string = pidNamespaceId()): string {
  return crypto.createHash('sha1').update(`${hostname}\0${pidNamespace}`).digest('hex').slice(0, 8);
}

module.exports = { hostTag, pidNamespaceId };
