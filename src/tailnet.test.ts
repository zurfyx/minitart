import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTailnet, tailnetNames } from './tailnet.ts';

// The shape `tailscale serve status --json` prints, with made-up names.
const config = {
  TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '8080': { HTTP: true } },
  Web: {
    'mini.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
    'mini.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4141' } } },
    'mini.example.ts.net:8080': { Handlers: { '/': { Proxy: 'http://localhost:4141' } } },
  },
  AllowFunnel: { 'mini.example.ts.net:8443': true },
  Services: {
    'svc:minitart': {
      TCP: { '443': { HTTPS: true } },
      Web: {
        'minitart.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4141' } } },
      },
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

test('the names Tailscale forwards to the dashboard, and only those', () => {
  assert.deepEqual(tailnetNames(config, 4141), [
    {
      host: 'mini.example.ts.net:8443',
      origin: 'https://mini.example.ts.net:8443',
      service: null,
      funnel: true,
    },
    {
      host: 'mini.example.ts.net:8080',
      origin: 'http://mini.example.ts.net:8080',
      service: null,
      funnel: false,
    },
    {
      host: 'minitart.example.ts.net',
      origin: 'https://minitart.example.ts.net',
      service: 'svc:minitart',
      funnel: false,
    },
  ]);
  // A site that only forwards one of its paths here is not the dashboard's name.
  assert.ok(!tailnetNames(config, 4141).some((name) => name.host.startsWith('other.')));
  assert.deepEqual(tailnetNames(config, 9999), []);
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
  assert.equal((await readTailnet(4141, async () => JSON.stringify(config))).length, 3);
});
