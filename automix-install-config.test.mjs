import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('AutoMix skips optional CUDA downloads while retaining its CPU runtime', async () => {
  const [npmrc, packageJson, autoMixSource] = await Promise.all([
    readFile(new URL('./.npmrc', import.meta.url), 'utf8'),
    readFile(new URL('./package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('./bitconnection/automix.mjs', import.meta.url), 'utf8')
  ]);

  assert.ok(npmrc.split(/\r?\n/).includes('onnxruntime-node-install=skip'));
  assert.equal(packageJson.dependencies['onnxruntime-node'], '1.31.1');
  assert.ok(autoMixSource.includes("executionProviders: ['cpu']"));
  assert.ok(autoMixSource.includes("import('onnxruntime-node')"));
});
