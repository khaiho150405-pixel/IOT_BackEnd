import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

/**
 * Local HTTPS without a public domain: the backend creates its own certificate
 * authority once (kept in data/tls), then a server certificate for aiot.local,
 * localhost, the machine name and its current LAN addresses. Phones install the CA
 * once (from /ca.crt) and then trust https://aiot.local — required for installing
 * the dashboard as an app (PWA) and so passwords never cross the LAN in clear text.
 */
export interface TlsMaterial { key: string; cert: string; caCert: string; names: string[]; ips: string[] }

const CA_YEARS = 10;
const LEAF_DAYS = 397; // Apple/Chrome reject server certificates valid for more than 398 days

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map(a => a.address);
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

function serial() {
  // Positive 16-byte serial number in hex.
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function createCa() {
  const { privatePem, publicKey } = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 86400_000);
  const subject = [{ name: 'commonName', value: 'AIoT Smart Room Local CA' }, { name: 'organizationName', value: 'AIoT Smart Room' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privatePem), forge.md.sha256.create());
  return { key: privatePem, cert: forge.pki.certificateToPem(cert) };
}

function createLeaf(caKeyPem: string, caCertPem: string, names: string[], ips: string[]) {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const { privatePem, publicKey } = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 86400_000);
  cert.setSubject([{ name: 'commonName', value: names[0] }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      ...names.map(value => ({ type: 2, value })),   // DNS
      ...ips.map(ip => ({ type: 7, ip })),          // IP address
    ] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
  return { key: privatePem, cert: forge.pki.certificateToPem(cert) };
}

/**
 * Loads (or creates) the CA and a server certificate covering the current names/IPs.
 * The server certificate is re-issued when the LAN addresses change or it nears expiry;
 * the CA stays the same, so phones never need to re-install it.
 */
export function ensureTls(dir: string, mdnsName: string): TlsMaterial {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => join(dir, name);
  if (!existsSync(file('ca.key')) || !existsSync(file('ca.crt'))) {
    const ca = createCa();
    writeFileSync(file('ca.key'), ca.key, { mode: 0o600 });
    writeFileSync(file('ca.crt'), ca.cert);
    console.log(`[TLS] Created local certificate authority ${file('ca.crt')}`);
  }
  const caKey = readFileSync(file('ca.key'), 'utf8');
  const caCert = readFileSync(file('ca.crt'), 'utf8');
  const machine = hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const names = [...new Set([`${mdnsName}.local`, 'localhost', `${machine}.local`, machine])];
  const ips = [...new Set(['127.0.0.1', ...lanAddresses()])];
  const wanted = JSON.stringify({ names, ips });
  let current: { names: string[]; ips: string[]; notAfter: string } | undefined;
  try { current = JSON.parse(readFileSync(file('server.json'), 'utf8')); } catch { /* none yet */ }
  const fresh = current && JSON.stringify({ names: current.names, ips: current.ips }) === wanted &&
    new Date(current.notAfter).getTime() - Date.now() > 30 * 86400_000 &&
    existsSync(file('server.key')) && existsSync(file('server.crt'));
  if (!fresh) {
    const leaf = createLeaf(caKey, caCert, names, ips);
    writeFileSync(file('server.key'), leaf.key, { mode: 0o600 });
    writeFileSync(file('server.crt'), leaf.cert);
    writeFileSync(file('server.json'), JSON.stringify({ names, ips,
      notAfter: forge.pki.certificateFromPem(leaf.cert).validity.notAfter.toISOString() }, null, 1));
    console.log(`[TLS] Issued server certificate for ${[...names, ...ips].join(', ')}`);
  }
  return { key: readFileSync(file('server.key'), 'utf8'), cert: readFileSync(file('server.crt'), 'utf8'), caCert, names, ips };
}
