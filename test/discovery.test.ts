import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkIssuer, discoverIssuer } from '../src/admin/discovery.ts';

// The console fetches the metadata of an address an organization's admin gives (AC1b.2): only https to public
// addresses; plain http and local addresses only in local mode; no redirects, a time and a size limit.

const META = (issuer: string) => ({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs` });
const fetchOk = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test('DI-01: an issuer is an https address without user info, query or fragment; http only for a local one in local mode', () => {
  assert.equal(checkIssuer('https://login.acme.example/realms/acme', false), 'https://login.acme.example/realms/acme');
  assert.equal(checkIssuer('https://login.acme.example/', false), 'https://login.acme.example', 'a trailing slash goes');
  for (const bad of ['http://login.acme.example', 'https://u:p@login.acme.example', 'https://login.acme.example/?x=1', 'https://login.acme.example/#f', 'ftp://x', 'not a url', 'http://localhost:8180/realms/x']) {
    assert.throws(() => checkIssuer(bad, false), /issuer/, bad);
  }
  assert.equal(checkIssuer('http://localhost:8180/realms/cust', true), 'http://localhost:8180/realms/cust');
  assert.throws(() => checkIssuer('http://login.acme.example', true), /issuer/, 'local mode allows http only for localhost');
});

test('DI-02: the host must resolve only to public addresses, unless in local mode', async () => {
  const lookup = (addresses: string[]) => async () => addresses;
  const issuer = 'https://login.acme.example';
  for (const addr of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '100.64.0.1', '::ffff:10.0.0.1']) {
    await assert.rejects(discoverIssuer(issuer, { allowLocal: false, lookup: lookup(['93.184.216.34', addr]), fetchImpl: fetchOk(META(issuer)) }), /not a public address/, addr);
  }
  assert.deepEqual(await discoverIssuer(issuer, { allowLocal: false, lookup: lookup(['93.184.216.34']), fetchImpl: fetchOk(META(issuer)) }), META(issuer));
  const local = 'http://localhost:8180/realms/cust';
  assert.deepEqual(await discoverIssuer(local, { allowLocal: true, lookup: lookup(['127.0.0.1']), fetchImpl: fetchOk(META(local)) }), META(local));
});

test('DI-03: the metadata request follows no redirect and gives up on a large or non-JSON answer', async () => {
  const issuer = 'https://login.acme.example';
  const lookup = async () => ['93.184.216.34'];
  let seen: RequestInit | undefined;
  const capture = (async (_url: string, init?: RequestInit) => { seen = init; return new Response(JSON.stringify(META(issuer))); }) as unknown as typeof fetch;
  await discoverIssuer(issuer, { allowLocal: false, lookup, fetchImpl: capture });
  assert.equal(seen?.redirect, 'error');
  assert.ok(seen?.signal, 'with a time limit');
  const big = (async () => new Response('x'.repeat(300_000))) as unknown as typeof fetch;
  await assert.rejects(discoverIssuer(issuer, { allowLocal: false, lookup, fetchImpl: big }), /too large/);
  const html = (async () => new Response('<html>')) as unknown as typeof fetch;
  await assert.rejects(discoverIssuer(issuer, { allowLocal: false, lookup, fetchImpl: html }), /not JSON/);
  const failing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(discoverIssuer(issuer, { allowLocal: false, lookup, fetchImpl: failing }), /404/);
});
