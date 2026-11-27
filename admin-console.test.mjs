import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('admin console embeds the three real product pages as previews', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src', 'AdminConsole.jsx'), 'utf8');
  assert.ok(source.includes("id: 'bitcider', name: 'BitCider', page: '/'"));
  assert.ok(source.includes("id: 'bitmono', name: 'BitMono', page: '/bitmono/'"));
  assert.ok(source.includes("id: 'bitconnection', name: 'BitConnection', page: '/bitconnection/'"));
  assert.ok(source.includes('<iframe'));
  assert.ok(source.includes('src={site.page}'));
  assert.ok(source.includes('title={site.name + \' live page preview\'}'));
});

test('BitChord sample test verifies Chicago by Michael Jackson through manifest, search, and stream', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src', 'AdminConsole.jsx'), 'utf8');
  assert.ok(source.includes("async function runPersonalAddonChecks(stage = 'stream', query = 'Chicago Michael Jackson')"));
  assert.ok(source.includes("String(item.title || '').trim().toLowerCase() === 'chicago'"));
  assert.ok(source.includes("String(item.artist || '').toLowerCase().includes('michael jackson')"));
  assert.ok(source.includes("manifestPath.replace(/\\/manifest\\.json$/, '/search')"));
  assert.ok(source.includes("manifestPath.replace(/\\/manifest\\.json$/, '/stream/'"));
  assert.ok(source.includes("mediaUrl.protocol !== 'https:'"));
  assert.ok(source.includes("'/api/status'"));
  assert.ok(source.includes('manifestPath = addonUrl.pathname'));
  assert.ok(source.includes('manifest = await requestJson(manifestPath)'));
  assert.ok(source.includes("'/search'"));
  assert.ok(source.includes("'/stream/'"));
  assert.ok(source.includes("quality=high"));
  assert.ok(source.includes("resolveRendition(track.id, 'low')"));
  assert.ok(source.includes("atmos=auto"));
});

test('BitMono sample checks verify full-file cache, checksum, and delivered quality', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src', 'AdminConsole.jsx'), 'utf8');
  assert.ok(source.includes("async function runBitMonoChecks(stage = 'search', query = 'Chicago Michael Jackson')"));
  assert.ok(source.includes("'/bitmono/manifest.json'"));
  assert.ok(source.includes("'/bitmono/search?q='"));
  assert.ok(source.includes("'/bitmono/stream/'"));
  assert.ok(source.includes('stream.cacheReady === true'));
  assert.ok(source.includes('stream.buffered === true'));
  assert.ok(source.includes('stream.sha256'));
  assert.ok(source.includes("record(\n      'mono-cache'"));
  assert.ok(source.includes("'mono-stream': 'stream'"));
  assert.ok(source.includes("'mono-cache': 'stream'"));
  assert.ok(source.includes("'mono-lossless': 'quality'"));
  assert.ok(source.includes("'mono-hires-atmos': 'quality'"));
  assert.ok(source.includes('downloads the complete sample track'));
});

test('stream and rendition tests disclose Cider queue side effects before resolving', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src', 'AdminConsole.jsx'), 'utf8');
  assert.ok(source.includes('window.confirm('));
  assert.ok(source.includes('temporarily selects the track in its queue and pauses after resolving the media URL'));
  assert.ok(source.includes('It will not play or download the song.'));
});

test('feature and subfeature test controls are wired to targeted checks', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src', 'AdminConsole.jsx'), 'utf8');
  assert.ok(source.includes('TEST FEATURE BRANCH'));
  assert.ok(source.includes('TEST SUBFEATURE'));
  assert.ok(source.includes('admin-inspector-child-test'));
  assert.ok(source.includes("'bc-addon-manifest': 'manifest'"));
  assert.ok(source.includes("'bc-addon-search': 'search'"));
  assert.ok(source.includes("'bc-addon-stream': 'stream'"));
  assert.ok(source.includes("'bc-renditions': 'renditions'"));
  assert.ok(source.includes("runPersonalAddonChecks(addonStage)"));
});

test('admin UI uses the simplified product-first styling', async () => {
  const css = await fs.readFile(path.join(ROOT, 'src', 'admin-console.css'), 'utf8');
  assert.ok(css.includes('calm, readable control room'));
  assert.ok(css.includes('.admin-product-preview-grid'));
  assert.ok(css.includes('.admin-addon-test'));
  assert.ok(css.includes('.admin-inspector-child-test'));
});
