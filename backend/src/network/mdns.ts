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
