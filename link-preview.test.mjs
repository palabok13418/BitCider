import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('BitCider and BitMono each expose their own share preview and open the matching mode', async () => {
  const [ciderHtml, monoHtml, appSource, viteConfig, packageJson] = await Promise.all([
    fs.readFile(path.join(ROOT, 'index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'bitmono', 'index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src', 'App.jsx'), 'utf8'),
    fs.readFile(path.join(ROOT, 'vite.config.js'), 'utf8'),
    fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
  ]);

  const imageUrl = 'https://bitcider.palabokmagtiis.workers.dev/link_preview.png';
  const ciderDescription = 'Connect Cider to BitCider and create your own personal BitChord source, with encrypted account syncing and smooth, seekable audio streaming.';
  const monoDescription = 'Use BitMono as your personal BitChord audio source, powered by Monochrome with Deezer fallback, complete-track caching, and smooth, seekable playback.';

  for (const html of [ciderHtml, monoHtml]) {
    assert.ok(html.includes('property="og:image"'));
    assert.ok(html.includes(imageUrl));
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
    assert.ok(html.includes('property="og:image:width" content="1200"'));
    assert.ok(html.includes('property="og:image:height" content="600"'));
  }

  assert.ok(ciderHtml.includes('<title>BitCider</title>'));
  assert.ok(ciderHtml.includes(ciderDescription));
  assert.ok(ciderHtml.includes('https://bitcider.palabokmagtiis.workers.dev/'));

  assert.ok(monoHtml.includes('<title>BitMono | BitCider</title>'));
  assert.ok(monoHtml.includes(monoDescription));
  assert.ok(monoHtml.includes('https://bitcider.palabokmagtiis.workers.dev/bitmono/'));
  assert.ok(monoHtml.includes('href="/monofavicon.svg"'));

  assert.ok(viteConfig.includes("resolve(projectRoot, 'bitmono/index.html')"));
  assert.match(appSource, /window\.location\.pathname\.replace\(\/\\\/\+\$\//);
  assert.ok(appSource.includes("const nextPath = nextMode === 'mono' ? '/bitmono/' : '/'"));
  assert.ok(appSource.includes('window.history.replaceState('));
  assert.ok(packageJson.includes('link-preview.test.mjs'));
});
