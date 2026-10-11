import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadX509FromPem } from '@reclaimprotocol/tls';
import { verifyStrictCertificateChain } from '../src/worker-certificates.js';
import '../worker-transport.js';

test('strict verifier validates a real signed chain and rejects CA, identity, usage, expiry and critical-extension violations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-certificate-test-'));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  const certificate = async (name) => loadX509FromPem(await readFile(join(directory, `${name}.pem`)));
  async function issue(name, issuer, extensions, { days = '1', cn = 'www.example.com', signature = 'sha256' } = {}) {
    openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
    await writeFile(join(directory, `${name}.ext`), extensions, { mode: 0o600 });
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-out', `${name}.pem`, '-days', days, `-${signature}`, '-extfile', `${name}.ext`);
  }
  try {
    openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2', '-subj', '/CN=Fixture Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    openssl('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');
    const trustedRoots = [await readFile(join(directory, 'root.der'))];
    const validExtensions = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:www.example.com\n';
    await issue('valid', 'root', validExtensions);
    await verifyStrictCertificateChain([await certificate('valid')], 'www.example.com', { trustedRoots });
    await t.test('configured SHA1 self-signed trust anchor is accepted only with strong leaf signature', async () => {
      openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'legacy-root.key', '-out', 'legacy-root.pem', '-days', '2', '-sha1', '-subj', '/CN=Fixture Legacy Trust Anchor', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
      openssl('x509', '-in', 'legacy-root.pem', '-outform', 'DER', '-out', 'legacy-root.der');
      const legacyRoots = [await readFile(join(directory, 'legacy-root.der'))];
      await issue('legacy-anchor-leaf', 'legacy-root', validExtensions);
      await verifyStrictCertificateChain([await certificate('legacy-anchor-leaf'), await certificate('legacy-root')], 'www.example.com', { trustedRoots: legacyRoots });
      await assert.rejects(verifyStrictCertificateChain([await certificate('legacy-anchor-leaf'), await certificate('legacy-root')], 'www.example.com', { trustedRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/);
      await issue('weak-leaf', 'legacy-root', validExtensions, { signature: 'sha1' });
      await assert.rejects(verifyStrictCertificateChain([await certificate('weak-leaf')], 'www.example.com', { trustedRoots: legacyRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/);
      await issue('weak-ca', 'legacy-root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', { cn: 'Weak Intermediate', signature: 'sha1' });
      await issue('weak-ca-leaf', 'weak-ca', validExtensions);
      await assert.rejects(verifyStrictCertificateChain([await certificate('weak-ca-leaf'), await certificate('weak-ca')], 'www.example.com', { trustedRoots: legacyRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/);
    });
    await t.test('untrusted root', async () => await assert.rejects(verifyStrictCertificateChain([await certificate('valid')], 'www.example.com', { trustedRoots: [] }), /PROXY_TLS_CERTIFICATE_REJECTED/));
    for (const [name, extensions, options] of [
      ['mismatch', validExtensions.replace('DNS:www.example.com', 'DNS:other.example.com'), {}],
      ['client-auth', validExtensions.replace('serverAuth', 'clientAuth'), {}],
      ['no-signature', validExtensions.replace('digitalSignature', 'keyEncipherment'), {}],
      ['unknown-critical', `${validExtensions}1.2.3.4=critical,DER:0C:01:61\n`, {}],
    ]) {
      await issue(name, 'root', extensions, options);
      await t.test(name, async () => await assert.rejects(verifyStrictCertificateChain([await certificate(name)], 'www.example.com', { trustedRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/));
    }
    await t.test('expired chain', async () => await assert.rejects(verifyStrictCertificateChain([await certificate('valid')], 'www.example.com', { trustedRoots, checkDate: new Date(Date.now() + 3 * 86_400_000) }), /PROXY_TLS_CERTIFICATE_REJECTED/));
    await issue('not-ca', 'root', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n', { cn: 'End Entity Issuer' });
    await issue('invalid-chain', 'not-ca', validExtensions);
    await t.test('end-entity certificate cannot issue another server certificate', async () => await assert.rejects(verifyStrictCertificateChain([await certificate('invalid-chain'), await certificate('not-ca')], 'www.example.com', { trustedRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/));
    await issue('constraint-ca', 'root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:allowed.example.com\n', { cn: 'Constrained Issuer' });
    await issue('outside-constraint', 'constraint-ca', validExtensions);
    await t.test('CA name constraint is enforced', async () => await assert.rejects(verifyStrictCertificateChain([await certificate('outside-constraint'), await certificate('constraint-ca')], 'www.example.com', { trustedRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/));
    await issue('pathlen-ca', 'root', 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n', { cn: 'Path Length Zero' });
    await issue('extra-ca', 'pathlen-ca', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', { cn: 'Unexpected Extra CA' });
    await issue('pathlen-leaf', 'extra-ca', validExtensions);
    await t.test('CA path length is enforced', async () => await assert.rejects(verifyStrictCertificateChain([await certificate('pathlen-leaf'), await certificate('extra-ca'), await certificate('pathlen-ca')], 'www.example.com', { trustedRoots }), /PROXY_TLS_CERTIFICATE_REJECTED/));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
