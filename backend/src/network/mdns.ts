import makeMdns from 'multicast-dns';
import { networkInterfaces } from 'node:os';

/**
 * Answers multicast DNS queries for "<name>.local" (default aiot.local) with this
 * machine's LAN address, so phones and laptops on the same Wi-Fi can open
 * https://aiot.local:3443 instead of an IP that changes. Only A records are answered;
 * the reply prefers the address on the same subnet as whoever asked.
 */
export interface MdnsHandle { name: string; stop(): void }

function addressFor(remote: string): string[] {
  const all = Object.values(networkInterfaces()).flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal);
  const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const same = all.filter(a => {
    const mask = toInt(a.netmask);
    return (toInt(a.address) & mask) === (toInt(remote) & mask);
  });
  return (same.length ? same : all).map(a => a.address);
}

/**
 * This machine's address on the same IPv4 subnet as a device that reported its address and
 * netmask (e.g. the ESP32 on the home Wi-Fi), or undefined when they are on different networks.
 */
export function laptopAddressFor(deviceIp: string, netmask: string): string | undefined {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  if (!ipv4.test(deviceIp) || !ipv4.test(netmask) || deviceIp.split('.').some(n => Number(n) > 255)) return undefined;
  const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const mask = toInt(netmask);
  // Only small private networks (at least /16): never hint across the Internet.
  if (mask < toInt('255.255.0.0') || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(deviceIp)) return undefined;
  return Object.values(networkInterfaces()).flat()
    .find(a => !!a && a.family === 'IPv4' && !a.internal && a.address !== deviceIp &&
      ((toInt(a.address) & mask) >>> 0) === ((toInt(deviceIp) & mask) >>> 0))?.address;
}

export function startMdns(label = 'aiot', ttl = 120): MdnsHandle | undefined {
  const name = `${label.toLowerCase()}.local`;
  let responder: ReturnType<typeof makeMdns>;
  try {
    responder = makeMdns({ reuseAddr: true });
  } catch (error) {
    console.warn(`[mDNS] Not started: ${(error as Error).message}`);
    return undefined;
  }
  responder.on('error', error => console.warn(`[mDNS] ${(error as Error).message}`));
  responder.on('query', (query, rinfo) => {
    const asked = query.questions.some(q => q.name.toLowerCase() === name && (q.type === 'A' || (q.type as string) === 'ANY'));
    if (!asked) return;
    const answers = addressFor(rinfo?.address ?? '0.0.0.0')
      .map(data => ({ name, type: 'A' as const, ttl, data, flush: true }));
    if (answers.length) responder.respond({ answers });
  });
  console.log(`[mDNS] Answering ${name} on the local network`);
  return { name, stop: () => responder.destroy() };
}
