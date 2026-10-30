import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import console from 'node:console';
import { URL } from 'node:url';
const root = new URL('../dist/', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const manifest = JSON.parse(await read('manifest.webmanifest'));
assert.equal(manifest.id, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.start_url, '/day');
assert.equal(manifest.display, 'standalone');
assert(
  manifest.icons.some(
    (icon) => icon.sizes === '192x192' && icon.purpose === 'any',
  ),
);
assert(
  manifest.icons.some(
    (icon) => icon.sizes === '512x512' && icon.purpose === 'maskable',
  ),
);
const html = await read('index.html');
assert.match(html, /rel="manifest"/);
assert.match(html, /apple-touch-icon/);
const worker = await read('sw.js');
// Check the release artifact: every split chunk, worker and icon must be usable offline.
const assets = await readdir(new URL('assets/', root));
for (const file of assets.filter((name) => /\.(js|css|woff2?)$/.test(name))) {
  assert(worker.includes(`assets/${file}`), `Missing precached asset: ${file}`);
}
for (const icon of manifest.icons) {
  const png = await readFile(new URL('.' + icon.src, root));
  const size = Number(icon.sizes.split('x')[0]);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert(
    worker.includes(icon.src.slice(1)),
    `Missing precached icon: ${icon.src}`,
  );
}
const urls = [...worker.matchAll(/url:"([^"]+)"/g)].map((match) => match[1]);
assert(urls.includes('index.html'));
assert(
  urls.every((url) =>
    /^(?:assets\/|icons\/|index\.html$|manifest\.webmanifest$)/.test(url),
  ),
  'Precache must contain public build output only',
);
assert(
  !/registerRoute\([^]*NetworkFirst|registerRoute\([^]*CacheFirst/.test(worker),
  'Private HTTP responses must not be runtime-cached',
);
console.log(
  `PWA release verified: ${urls.length} static resources, install icons and offline chunks.`,
);
