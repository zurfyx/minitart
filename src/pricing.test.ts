import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICES_CHECKED, PROVIDERS } from './pricing.ts';

test('the price list: each provider from its own page, its runners named once, prices that are prices', () => {
  assert.match(PRICES_CHECKED, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(
    PROVIDERS.map((one) => one.id),
    ['github', 'blacksmith', 'depot', 'namespace', 'warpbuild', 'avrea'],
  );
  for (const provider of PROVIDERS) {
    assert.match(provider.source, /^https:\/\//, provider.id);
    assert.ok(provider.note.length > 0, provider.id);
    for (const kind of [provider.linux, provider.macos]) {
      assert.ok(kind.length > 0, `${provider.id} has runners of each kind`);
      assert.equal(new Set(kind.map((runner) => runner.id)).size, kind.length, provider.id);
      for (const runner of kind) {
        assert.ok(runner.usd > 0 && runner.usd < 1, `${provider.id} ${runner.id}`);
        // Every runner has its size, and every name is written the one way.
        assert.ok(runner.memoryGb >= runner.cores, `${provider.id} ${runner.id}`);
        assert.match(
          runner.name,
          /^(Linux \d+ vCPU, \d+ GB, (x64|arm64)|macOS \d+ vCPU, \d+ GB(, .+)?)$/,
          `${provider.id} ${runner.id}`,
        );
      }
    }
    // The defaults compare like with like: the size of GitHub's ubuntu-latest, and the
    // provider's smallest macOS runner.
    assert.deepEqual([provider.linux[0]?.cores, provider.linux[0]?.arch], [2, 'x64'], provider.id);
    const smallest = Math.min(...provider.macos.map((runner) => runner.cores));
    assert.equal(provider.macos[0]?.cores, smallest, provider.id);
  }
});

test('runner names say the same things in the same order', () => {
  const github = PROVIDERS.find((one) => one.id === 'github');
  assert.equal(github?.linux[0]?.name, 'Linux 2 vCPU, 8 GB, x64');
  assert.equal(github?.macos[0]?.name, 'macOS 3 vCPU, 7 GB, M1');
  const namespace = PROVIDERS.find((one) => one.id === 'namespace');
  assert.equal(namespace?.macos[0]?.name, 'macOS 4 vCPU, 7 GB', 'no chip where none is named');
});
