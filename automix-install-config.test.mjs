import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('AutoMix skips optional CUDA downloads while retaining its CPU runtime', async () => {
  const [npmrc, packageJson, autoMixSource] = await Promise.all([
    readFile(new URL('./.npmrc', import.meta.url), 'utf8'),
    readFile(new URL('./package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('./bitconnection/automix.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(npmrc, /^onnxruntime-node-install=skip\\s*$/m);
  assert.equal(packageJson.dependencies['onnxruntime-node'], '1.31.1');
  assert.match(autoMixSource, /executionProviders:\\s*\\[\\s*['"]cpu['"]\\s*\\]/);
  assert.match(autoMixSource, /import\\(['"]onnxruntime-node['"]\\)/);
});
