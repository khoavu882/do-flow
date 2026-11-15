'use strict';

// Which address `doflow ui --lan` listens on when `--listen-address` is not given (feature 160, design D2).
// Auto-choice keeps RFC1918 IPv4 addresses of non-virtual interfaces and takes one only when exactly one
// remains; otherwise it refuses and lists every private address seen, so the person names one. 100.64/10
// (Tailscale and other CGNAT) is listed but never chosen: it reaches beyond the LAN (row 164's ground).

/** Interface-name prefixes of virtual, tunnel, bridge and container interfaces, compared case-insensitively. */
const VIRTUAL_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'vmnet', 'vboxnet', 'utun', 'tun', 'tap', 'tailscale', 'zt', 'wg', 'bridge',
  'vethernet', 'lxc', 'lxd', 'cni', 'flannel', 'podman', 'awdl', 'llw', 'anpi', 'ppp', 'ipsec', 'cscotun', 'gpd'];
/** Windows adapter names are free text ("VMware Network Adapter VMnet8", "Ethernet 2 (TAP-Windows)"): matched anywhere in the name, case-insensitively. */
const VIRTUAL_WORDS = ['vmware', 'virtualbox', 'hyper-v', 'vethernet', 'tap-', 'wireguard', 'tailscale', 'zerotier'];
const RULE = 'the only private IPv4 address on a non-virtual interface';

type Seen = { address: string, iface: string };
type Chosen = { address: string, iface: string, rule: string };
type Refusal = { error: string, seen: Seen[] };

function octets(address: string): number[] | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!parts) return null;
  const values = parts.slice(1).map(Number);
  return values.every((value) => value <= 255) ? values : null;
}

const isRfc1918 = ([a, b]: number[]) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
const isCgnat = ([a, b]: number[]) => a === 100 && b >= 64 && b <= 127;
const isVirtual = (name: string) => {
  const lower = name.toLowerCase();
  return VIRTUAL_PREFIXES.some((prefix) => lower.startsWith(prefix)) || VIRTUAL_WORDS.some((word) => lower.includes(word));
};

/** `interfaces` is the shape of `os.networkInterfaces()`. One address, or the refusal with every private address seen. */
function chooseLanAddress(interfaces: Record<string, any[] | undefined>): Chosen | Refusal {
  const seen: Seen[] = [];
  const candidates: Seen[] = [];
  for (const iface of Object.keys(interfaces).sort()) {
    for (const entry of interfaces[iface] ?? []) {
      if (!entry || entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      const parts = typeof entry.address === 'string' ? octets(entry.address) : null;
      if (!parts || !(isRfc1918(parts) || isCgnat(parts))) continue;
      seen.push({ address: entry.address, iface });
      if (isRfc1918(parts) && !isVirtual(iface)) candidates.push({ address: entry.address, iface });
    }
  }
  if (candidates.length === 1) return { ...candidates[0], rule: RULE };
  return { error: candidates.length === 0 ? 'no private IPv4 address on a non-virtual interface' : 'several private IPv4 addresses on non-virtual interfaces', seen };
}

module.exports = { chooseLanAddress, VIRTUAL_PREFIXES, VIRTUAL_WORDS, RULE };
