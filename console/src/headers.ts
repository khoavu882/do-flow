'use strict';

// The response header set of 092 IC-010, applied to every Console response (IC-006): static files,
// API bodies, errors, 404, 405, 421 and the raw 400 of a malformed request. One function, so no
// response path can carry a different set.

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

// `api` is true for a request path under /api/: those responses are never cached (092 IC-010).
function securityHeaders(api: boolean): Record<string, string> {
  return api ? { ...BASE_HEADERS, 'Cache-Control': 'no-store' } : { ...BASE_HEADERS };
}

module.exports = { securityHeaders, CSP };
