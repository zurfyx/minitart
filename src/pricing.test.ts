import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICES_CHECKED, PROVIDERS } from './pricing.ts';

test('the price list: each provider from its own page, like for like, prices that are prices', () => {
  assert.match(PRICES_CHECKED, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(
    PROVIDERS.map((one) => one.id),
    ['github', 'blacksmith', 'depot', 'namespace', 'warpbuild', 'avrea'],
  );
  for (const provider of PROVIDERS) {
    assert.match(provider.source, /^https:\/\//, provider.id);
    assert.ok(provider.note.length > 0, provider.id);
    // Like for like: a Linux runner the size of GitHub's ubuntu-latest, and a macOS one.
    assert.deepEqual([provider.linux.cores, provider.linux.arch], [2, 'x64'], provider.id);
    assert.equal(provider.macos.arch, 'arm64', provider.id);
    for (const runner of [provider.linux, provider.macos]) {
      assert.ok(runner.usd > 0 && runner.usd < 1, `${provider.id} ${runner.name}`);
    }
  }
});
