import { Certificate, CertificateChainValidationEngine, CryptoEngine, setEngine } from 'pkijs';
import { fromBER } from 'asn1js';
import { MOZILLA_ROOT_CA_LIST } from '@reclaimprotocol/tls';

const fail = (stage = 'shape') => { const error = new Error('PROXY_TLS_CERTIFICATE_REJECTED'); error.stage = stage; throw error; };
const parse = (bytes) => { const asn1 = fromBER(bytes); if (asn1.offset === -1) fail(); return new Certificate({ schema: asn1.result }); };
const pemBytes = (pem) => Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (char) => char.charCodeAt(0));
let roots;

export function exactDNSMatch(host, name) {
  if (typeof name !== 'string' || typeof host !== 'string') return false;
  const hostname = host.toLowerCase(), pattern = name.toLowerCase();
  if (pattern === hostname) return true;
  const labels = pattern.split('.'), actual = hostname.split('.');
  return labels.length >= 3 && labels.length === actual.length && labels[0] === '*'
    && !labels.slice(1).some((label) => label.includes('*')) && labels.slice(1).every((label, index) => label === actual[index + 1]);
}

export async function verifyStrictCertificateChain(chain, host, { trustedRoots, checkDate = new Date() } = {}) {
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > 8) fail();
  if (chain.some((certificate) => certificate.internal.rawData.byteLength > 131_072) || chain.reduce((bytes, certificate) => bytes + certificate.internal.rawData.byteLength, 0) > 524_288) fail();
  if (!chain[0].getAlternativeDNSNames().some((name) => exactDNSMatch(host, name))) fail('dns');
  setEngine('webcrypto', new CryptoEngine({ name: 'webcrypto', crypto: globalThis.crypto, subtle: globalThis.crypto.subtle }));
  const certificates = chain.map((certificate) => parse(certificate.internal.rawData));
  const critical = new Set(['2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.17', '2.5.29.30', '2.5.29.32', '2.5.29.33', '2.5.29.36', '2.5.29.54']);
  for (const certificate of certificates) {
    const seen = new Set();
    for (const extension of certificate.extensions ?? []) {
      if (seen.has(extension.extnID) || (extension.critical && (!critical.has(extension.extnID) || !extension.parsedValue))) fail('critical');
      seen.add(extension.extnID);
    }
  }
  const leaf = certificates[0];
  const basic = leaf.extensions?.find((extension) => extension.extnID === '2.5.29.19')?.parsedValue;
  if (basic?.cA) fail('leaf-ca');
  const usage = leaf.extensions?.find((extension) => extension.extnID === '2.5.29.15')?.parsedValue;
  if (usage && !(new Uint8Array(usage.valueBlock.valueHexView)[0] & 0x80)) fail('key-usage');
  const serverAuth = '1.3.6.1.5.5.7.3.1';
  for (const certificate of certificates) {
    const eku = certificate.extensions?.find((extension) => extension.extnID === '2.5.29.37')?.parsedValue;
    if (eku && !eku.keyPurposes.includes(serverAuth) && !eku.keyPurposes.includes('2.5.29.37.0')) fail('eku');
  }
  if (!trustedRoots && !roots) roots = MOZILLA_ROOT_CA_LIST.map((pem) => parse(pemBytes(pem)));
  // The validation engine expects the end-entity certificate last. Only Mozilla
  // roots are trust anchors; TLS library's extra anchors are never trusted here.
  const trustedCerts = trustedRoots?.map((bytes) => parse(bytes)) ?? roots;
  const validation = new CertificateChainValidationEngine({ trustedCerts, certs: certificates.reverse(), checkDate });
  const result = await validation.verify();
  if (!result.result) fail('chain');
  const anchor = result.certificatePath.at(-1);
  const sameCertificate = (first, second) => {
    const left = new Uint8Array(first.toSchema().toBER(false)), right = new Uint8Array(second.toSchema().toBER(false));
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  };
  if (!anchor || !trustedCerts.some((trusted) => sameCertificate(anchor, trusted))) fail('chain');
  // A preconfigured trust anchor's self-signature is not part of path validation.
  // Reject weak signatures on every selected leaf/intermediate, never infer trust
  // from self-issued status or from a server-supplied root certificate.
  for (const certificate of result.certificatePath.slice(0, -1)) {
    if (['1.2.840.113549.1.1.4', '1.2.840.113549.1.1.5', '1.2.840.10045.4.1'].includes(certificate.signatureAlgorithm.algorithmId)) fail('weak-signature');
  }
  // PKI.js validates CA/key/name/policy constraints but does not enforce pathLen.
  let below = 0;
  for (const issuer of result.certificatePath.slice(1)) {
    const constraints = issuer.extensions?.find((extension) => extension.extnID === '2.5.29.19')?.parsedValue;
    if (constraints?.pathLenConstraint != null && (!Number.isSafeInteger(constraints.pathLenConstraint) || constraints.pathLenConstraint < below)) fail('path-len');
    if (!issuer.issuer.isEqual(issuer.subject)) below++;
  }
}
