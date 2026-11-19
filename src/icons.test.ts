import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));

/** A PNG's width and height, from its header. */
function size(png: Buffer): [number, number] {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('the manifest makes an installable app: a name, a start, and icons of the sizes it says', () => {
  const manifest = JSON.parse(read('../dashboard/manifest.webmanifest').toString()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  assert.equal(manifest.name, 'minitart');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  // Chrome installs an app with a 192 and a 512 icon; a maskable one fills the shape the
  // system cuts.
  for (const purpose of ['any', 'maskable']) {
    for (const wanted of ['192x192', '512x512']) {
      const icon = manifest.icons.find((one) => one.purpose === purpose && one.sizes === wanted);
      assert.ok(icon, `${purpose} ${wanted}`);
      const [width, height] = size(read(`../dashboard${icon.src}`));
      assert.equal(`${width}x${height}`, wanted, icon.src);
    }
  }
  assert.deepEqual(size(read('../dashboard/icons/apple-touch-icon.png')), [180, 180]);
});

test('the website has the dashboard’s icons, unchanged', () => {
  for (const [site, dashboard] of [
    ['../site/favicon.svg', '../dashboard/favicon.svg'],
    ['../site/favicon.ico', '../dashboard/favicon.ico'],
    ['../site/apple-touch-icon.png', '../dashboard/icons/apple-touch-icon.png'],
    ['../site/icons/favicon-32.png', '../dashboard/icons/favicon-32.png'],
  ] as const) {
    assert.deepEqual(read(site), read(dashboard), site);
  }
});
