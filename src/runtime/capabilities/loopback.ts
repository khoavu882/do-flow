'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

interface LoopbackValidationResult {
  ok: boolean;
  reason?: string;
}

function validateLoopbackUrl(urlStr: string): LoopbackValidationResult {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    return { ok: false, reason: 'URL must be a non-empty string' };
  }

  let parsed: any;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    return { ok: false, reason: `Invalid URL: ${err.message}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Protocol '${parsed.protocol}' is not allowed; must be http: or https:` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(unbracketed)) {
    return {
      ok: false,
      reason: `Host '${hostname}' is not a permitted loopback host (must be 127.0.0.1, localhost, or [::1]): DISALLOWED_REMOTE_ENDPOINT`,
    };
  }

  return { ok: true };
}

module.exports = { validateLoopbackUrl, LOOPBACK_HOSTS };
