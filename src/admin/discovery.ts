import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * The OpenID metadata of an organization's own provider (AC1b.2, docs/plan-admin-console-ac1b.md). The address comes
 * from an organization's admin, so the console fetches it carefully: https only, every address the host resolves to
 * public, no redirects, a time and a size limit. Local mode (a console on localhost) also allows a provider on
 * localhost over http, for a second Keycloak realm in development. Keycloak fetches the provider's keys itself later.
 */
export interface DiscoverOptions {
  allowLocal: boolean;
  fetchImpl?: typeof fetch;
  /** Every address the host resolves to (for tests). */
  lookup?: (host: string) => Promise<string[]>;
}

const TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The issuer as Keycloak will compare it (no trailing slash), or an error that names what is wrong. */
export function checkIssuer(raw: string, allowLocal: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('the issuer is not an address');
  }
  const local = allowLocal && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('the issuer must be an https address');
  if (url.username || url.password || url.search || url.hash) throw new Error('the issuer has no user, query or fragment');
  return url.toString().replace(/\/+$/, '');
}

/** A metadata address an organization's admin gave: https (local mode: also localhost over http), no user or fragment. */
export function checkMetadataUrl(raw: string, allowLocal: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('the metadata address is not an address');
  }
  const local = allowLocal && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('the metadata address must be https');
  if (url.username || url.password || url.hash) throw new Error('the metadata address has no user or fragment');
  return url.toString();
}

/** GET with the console's checks: every resolved address public (unless local mode allows localhost), no redirects, limits. */
async function carefulGet(raw: string, options: DiscoverOptions, accept: string, what: string): Promise<string> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (options.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address)))(host);
  const local = options.allowLocal && LOCAL_HOSTS.has(url.hostname);
  for (const found of addresses) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4; Node's BlockList matches IPv4 against
    // IPv4-mapped IPv6 rules itself, so that range is not listed above.
    const address = found.toLowerCase().startsWith('::ffff:') && isIP(found.slice(7)) === 4 ? found.slice(7) : found;
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (!local && blocked.check(address, family)) throw new Error(`the ${what} host is not a public address (${address})`);
  }
  if (!addresses.length) throw new Error(`the ${what} host does not resolve`);
  const res = await (options.fetchImpl ?? fetch)(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept } });
  if (!res.ok) throw new Error(`the ${what} metadata answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`the ${what} metadata is too large`);
  return text;
}

/**
 * The SAML 2.0 metadata of an organization's own provider (docs/plan-saml.md), fetched by the console with the same
 * checks as OIDC metadata; Keycloak only parses it (import-config with a file), so Keycloak never fetches an address
 * an organization gave.
 */
export async function fetchSamlMetadata(raw: string, options: DiscoverOptions): Promise<string> {
  const text = await carefulGet(checkMetadataUrl(raw, options.allowLocal), options, 'application/samlmetadata+xml, application/xml, text/xml', 'SAML');
  if (!/<(\w+:)?EntityDescriptor[\s>]/.test(text)) throw new Error("the address does not give SAML metadata (no EntityDescriptor)");
  return text;
}

export async function discoverIssuer(issuer: string, options: DiscoverOptions): Promise<Record<string, unknown>> {
  const text = await carefulGet(`${checkIssuer(issuer, options.allowLocal)}/.well-known/openid-configuration`, options, 'application/json', "issuer's");
  try {
    const meta = JSON.parse(text) as unknown;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('not an object');
    return meta as Record<string, unknown>;
  } catch {
    throw new Error("the issuer's metadata is not JSON");
  }
}
