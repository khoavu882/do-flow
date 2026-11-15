'use strict';

// The pairing payload (feature 160, IC-003): one URL carrying address, port, certificate fingerprint and
// pairing code in its fragment, which never reaches a server or a Referer, as a link, as a text block for
// the terminal and as a QR code of the same URL. Pure: the caller passes whether stdout is a terminal and
// whether colour is allowed.

const net = require('node:net');
const { encode, render } = require('./qr.ts');

type Payload = { host: string, port: number, code: string, fingerprint: string };
type BlockInput = Payload & { interfaceName: string, rule: string, scope: 'view' | 'control', expiresAt: number, tty: boolean, color: boolean };

const CODE = /^[a-z2-7]{26}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** `https://<host>:<port>/#pair=<code>&fp=<64 hex>&v=1`, an IPv6 host in brackets. */
function payloadUrl({ host, port, code, fingerprint }: Payload): string {
  if (net.isIP(host) === 0 || host.includes('%')) throw new Error(`payload host ${JSON.stringify(host)} is not a literal IP address`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`payload port ${port} is not 1..65535`);
  if (!CODE.test(code)) throw new Error('payload code is not 26 base32 characters');
  if (!FINGERPRINT.test(fingerprint)) throw new Error('payload fingerprint is not 64 lowercase hex characters');
  const authority = net.isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname : host;
  return `https://${authority}:${port}/#pair=${code}&fp=${fingerprint}&v=1`;
}

const colonPairs = (fingerprint: string) => (fingerprint.toUpperCase().match(/../g) as string[]).join(':');
const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The block `doflow ui --lan` and `--action pair` print on stdout: labelled lines, then the QR on a terminal. */
function payloadBlock(input: BlockInput): string {
  const url = payloadUrl(input);
  const origin = url.slice(0, url.indexOf('/#'));
  const lines = [
    `doflow ui: LAN mode on ${origin}`,
    `  address      ${input.host} (${input.interfaceName}, ${input.rule})`,
    `  fingerprint  SHA-256 ${colonPairs(input.fingerprint)}`,
    `  pairing code ${input.code} (one use, expires ${clock(input.expiresAt)}, scope ${input.scope})`,
    `  link         ${url}`,
    input.tty ? render(encode(Buffer.from(url, 'utf8')), { color: input.color }) : '  (QR code shown on a terminal only)',
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { payloadUrl, payloadBlock, colonPairs };
