import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Home } from './home.ts';

test('the VM logs are the job VMs’ own: minitart’s log is not counted as one', () => {
  const home = new Home(mkdtempSync(join(tmpdir(), 'minitart-home-')));
  writeFileSync(home.path('logs', 'minitart-linux-0a1b2c.log'), 'x'.repeat(100));
  writeFileSync(home.path('logs', 'minitart-macos-0a1b2d.log'), 'y'.repeat(50));
  writeFileSync(home.path('logs', 'manager.log'), 'z'.repeat(1000));
  assert.deepEqual(home.logsUsage(), { files: 2, bytes: 150 });
  assert.equal(home.readLog('minitart-macos-0a1b2d.log', 10), 'y'.repeat(10), 'its end');
  assert.equal(home.readLog('minitart-linux-ffffff.log', 10), null);
});
