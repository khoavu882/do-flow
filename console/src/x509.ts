'use strict';

// A minimal X.509 v3 writer for the LAN certificate (feature 160, IC-002; design D1): DER by hand over
// `node:crypto`, so no `openssl` is spawned and nothing is installed. One profile only: a self-signed
// ECDSA P-256 / SHA-256 leaf whose subjectAltName is one IP address, CA:FALSE, digitalSignature,
// serverAuth. Node's own X509Certificate is the test oracle (test/x509.test.ts).

const crypto = require('node:crypto');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const VALID_DAYS = 397;

// ---- DER ----

/** The DER length octets for a content of `length` bytes: short form to 127, else the shortest long form. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const octetString = (content: Buffer): Buffer => tlv(0x04, content);
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));

/** A non-negative INTEGER from big-endian `bytes`: leading zeros dropped, one 0x00 added when the top bit is set. */
function derInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  return tlv(0x02, body[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
}

/** An OBJECT IDENTIFIER from its dotted form. */
function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const group = [arc & 0x7f];
    for (let rest = arc >>> 7; rest > 0; rest >>>= 7) group.unshift((rest & 0x7f) | 0x80);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime `YYMMDDHHMMSSZ` (valid for 1950-2049, which every certificate this writes falls in). */
function utcTime(ms: number): Buffer {
  const date = new Date(ms);
  const two = (value: number) => String(value).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`, 'ascii'));
}

// ---- addresses ----

/** The 4 or 16 network-order bytes of a literal IPv4 or IPv6 address (no zone id), or a throw. */
function ipBytes(address: string): Buffer {
  const fail = () => new Error(`${JSON.stringify(address)} is not an IP address`);
  const v4 = (text: string): number[] | null => {
    const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(text);
    const octets = match ? match.slice(1).map(Number) : null;
    return octets && octets.every((octet) => octet <= 255) ? octets : null;
  };
  const direct = v4(address);
  if (direct) return Buffer.from(direct);
  if (!address.includes(':') || address.includes('%')) throw fail();
  const halves = address.split('::');
  if (halves.length > 2) throw fail();
  const groupsOf = (text: string): number[] => {
    if (text === '') return [];
    const parts = text.split(':');
    const out: number[] = [];
    parts.forEach((part, index) => {
      if (index === parts.length - 1 && part.includes('.')) {
        const octets = v4(part);
        if (!octets) throw fail();
        out.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        throw fail();
      }
    });
    return out;
  };
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) throw fail();
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(group, index * 2));
  return out;
}

// ---- the certificate ----

const NAME = sequence(set(sequence(oid('2.5.4.3'), utf8String('DoFlow Console'))));
const SIGNATURE_ALGORITHM = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256, no parameters

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octetString(value));
}

/**
 * A self-signed certificate for `address` signed by `privateKey` (a P-256 KeyObject), valid from an hour
 * before `now` (ms) for 397 days. `pem` is the PEM wrapping of `der`.
 */
function issueCertificate({ address, privateKey, now }: { address: string, privateKey: any, now: number }): { der: Buffer, pem: string } {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 0x01;
  const notBefore = Math.floor(now / 1000) * 1000 - HOUR_MS;
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const extensions = sequence(
    extension('2.5.29.19', true, sequence()),                                // basicConstraints: CA:FALSE
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),      // keyUsage: digitalSignature
    extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),       // extKeyUsage: serverAuth
    extension('2.5.29.17', false, sequence(tlv(0x87, ipBytes(address)))),    // subjectAltName: one iPAddress
  );
  const tbs = sequence(
    tlv(0xa0, derInteger(Buffer.from([2]))),                                 // version v3
    derInteger(serial),
    SIGNATURE_ALGORITHM,
    NAME,
    sequence(utcTime(notBefore), utcTime(notBefore + VALID_DAYS * DAY_MS)),
    NAME,
    Buffer.from(spki),
    tlv(0xa3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(tbs, SIGNATURE_ALGORITHM, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return { der, pem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` };
}

module.exports = { issueCertificate, ipBytes, tlv, sequence, set, octetString, utf8String, derInteger, derLength, oid, utcTime, VALID_DAYS };
