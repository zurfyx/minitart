import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTailnet, tailnetNames } from './tailnet.ts';

// The shape `tailscale serve status --json` prints, with made-up names.
const config = {
  TCP: {
    '443': { HTTPS: true },
    '8443': { HTTPS: true },
    '8080': { HTTP: true },
    '9000': { TCPForward: 'localhost:4141' },
    '9001': { TCPForward: '127.0.0.1:22' },
  },
  Web: {
    'mini.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
    'mini.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4141/' } } },
    'mini.example.ts.net:8080': { Handlers: { '/': { Proxy: 'http://localhost:4141' } } },
  },
  Foreground: {
    session: { AllowFunnel: { 'mini.example.ts.net:8443': true } },
  },
  Services: {
    'svc:minitart': {
      TCP: { '443': { HTTPS: true } },
      Web: { 'minitart.example.ts.net:443': { Handlers: { '/': { Proxy: '127.0.0.1:4141' } } } },
    },
    'svc:other': {
      TCP: { '443': { HTTPS: true } },
      Web: {
        'other.example.ts.net:443': {
          Handlers: {
            '/': { Proxy: 'http://127.0.0.1:7777' },
            '/ci': { Proxy: 'http://127.0.0.1:4141' },
          },
        },
      },
    },
  },
};

test('the names Tailscale forwards to the dashboard, and what is wrong with each', () => {
  const names = tailnetNames(config, 4141);
  assert.deepEqual(
    names.map((name) => [name.host, name.origin, name.service, name.refused]),
    [
      // Funnel is on for it, in another part of the config.
      ['mini.example.ts.net:8443', 'https://mini.example.ts.net:8443', null, 'funnel'],
      ['mini.example.ts.net:8080', 'http://mini.example.ts.net:8080', null, 'plain-http'],
      ['tcp:9000', '', null, 'raw-tcp'],
      ['minitart.example.ts.net', 'https://minitart.example.ts.net', 'svc:minitart', null],
    ],
  );
  // A site that only forwards one of its paths here is not the dashboard's name.
  assert.ok(!names.some((name) => name.host.startsWith('other.')));
  assert.deepEqual(tailnetNames(config, 9999), []);
});

test('each refused name comes with a command that touches only that name', () => {
  const fixes = Object.fromEntries(tailnetNames(config, 4141).map((name) => [name.host, name.fix]));
  assert.equal(
    fixes['mini.example.ts.net:8443'],
    'tailscale serve --bg --https=8443 http://127.0.0.1:4141',
  );
  assert.equal(fixes['tcp:9000'], 'tailscale serve --tcp=9000 off');
  assert.equal(fixes['minitart.example.ts.net'], null);
  // Never the one that wipes every forward on the Mac.
  assert.ok(!Object.values(fixes).some((fix) => fix?.includes('reset')));
});

test('a target is the dashboard however it is written, and nothing else is', () => {
  const forwards = (proxy: unknown) =>
    tailnetNames(
      {
        TCP: { '443': { HTTPS: true } },
        Web: { 'a.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
      },
      4141,
    ).length === 1;
  for (const ours of [
    'http://127.0.0.1:4141',
    'http://127.0.0.1:4141/',
    'http://localhost:4141',
    '127.0.0.1:4141',
  ]) {
    assert.ok(forwards(ours), ours);
  }
  for (const other of [
    'http://127.0.0.1:4142',
    'http://127.0.0.1:4141/api',
    'https://127.0.0.1:4141',
    'https+insecure://127.0.0.1:4141',
    'http://192.168.1.20:4141',
    'http://127.0.0.1.example.com:4141',
    undefined,
    4141,
  ]) {
    assert.ok(!forwards(other), String(other));
  }
});

test('a config that is not understood yields no name', async () => {
  for (const odd of [
    null,
    [],
    'x',
    7,
    { Web: 'x' },
    { Services: [] },
    { Web: { 'no port': {} } },
  ]) {
    assert.deepEqual(tailnetNames(odd, 4141), []);
  }
  assert.deepEqual(await readTailnet(4141, async () => null), []);
  assert.deepEqual(await readTailnet(4141, async () => 'not json'), []);
  assert.deepEqual(await readTailnet(4141, () => Promise.reject(new Error('no tailscale'))), []);
  assert.equal((await readTailnet(4141, async () => JSON.stringify(config))).length, 4);
});
