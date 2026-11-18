import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the website uses the dashboard’s tokens, unchanged', () => {
  assert.equal(read('../site/tokens.css'), read('../dashboard/tokens.css'));
});

test('no colour is named outside the tokens', () => {
  for (const file of ['../dashboard/style.css', '../site/style.css']) {
    const colours = read(file).match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(colours, [], file);
  }
});
