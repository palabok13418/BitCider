#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CONFIG_PATH = path.resolve(process.argv[2] || './bitcider-relay.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error('Cannot read ' + CONFIG_PATH + ': ' + error.message);
  }
  if (!config || typeof config !== 'object') throw new Error('Relay config must be a JSON object.');
  const relay = new URL(String(config.relayUrl || ''));
  const local = new URL(String(config.ciderApiUrl || 'http://127.0.0.1:10767'));
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (relay.protocol !== 'https:' && !(relay.protocol === 'http:' && localHosts.has(relay.hostname))) {
    throw new Error('relayUrl must use HTTPS (HTTP is allowed only for local testing).');
  }
  if (relay.username || relay.password || relay.search || relay.hash || relay.pathname !== '/') {
    throw new Error('relayUrl must be an origin only, without credentials or a path.');
  }
  if (local.protocol !== 'http:' || !localHosts.has(local.hostname) || local.pathname !== '/' || local.search || local.hash) {
    throw new Error('ciderApiUrl must point only to the local Cider API at 127.0.0.1:10767.');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(config.relayKey || ''))) {
    throw new Error('The relay key in the config file is invalid. Download a fresh config from BitCider.');
  }
  if (String(config.ciderToken || '').length < 12 || String(config.ciderToken).length > 8192) {
    throw new Error('The Cider app token is missing or invalid. Download a fresh config from BitCider.');
  }
  return {
    relayUrl: relay.origin,
    relayKey: config.relayKey,
    ciderApiUrl: local.origin,
    ciderToken: config.ciderToken,
    requestTimeoutMs: Math.max(3000, Math.min(Number(config.requestTimeoutMs) || 18000, 25000))
  };
}

function allowedCiderRequest(job) {
  if (!job || typeof job !== 'object') return null;
  const method = String(job.method || 'GET').toUpperCase();
  let target;
  try { target = new URL(String(job.apiPath || ''), 'http://127.0.0.1:10767/'); }
  catch { return null; }
  if (target.origin !== 'http://127.0.0.1:10767' || !target.pathname.startsWith('/api/v2/')) return null;

  if (method === 'GET' && target.pathname === '/api/v2/amapi/search') {
    const keys = [...target.searchParams.keys()];
    const allowedKeys = new Set(['term', 'types', 'limit', 'offset']);
    if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !allowedKeys.has(key))) return null;
    const term = String(target.searchParams.get('term') || '').trim();
    const types = String(target.searchParams.get('types') || '');
    const limit = Number(target.searchParams.get('limit'));
    const offset = Number(target.searchParams.get('offset'));
    if (!term || term.length > 160 || types !== 'songs'
      || !Number.isInteger(limit) || limit < 1 || limit > 25
      || !Number.isInteger(offset) || offset < 0 || offset > 10000) return null;
    return { target, method };
  }
  if (method === 'POST' && target.pathname === '/api/v2/playback/play-item') {
    const id = String(job.body?.id || '');
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id) || job.body?.type !== 'songs') return null;
    return { target, method, body: { id, type: 'songs' } };
  }
  if (method === 'GET' && target.pathname === '/api/v2/queue' && !target.search) {
    return { target, method };
  }
  if (method === 'POST' && target.pathname === '/api/v2/playback/pause' && !target.search) {
    return { target, method };
  }
  return null;
}

async function postRelay(config, route, body) {
  const response = await fetch(config.relayUrl + route, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.relayKey
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(26000)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const error = new Error('This relay key has been revoked. Download a fresh BitCider relay config.');
    error.fatal = true;
    throw error;
  }
  if (!response.ok) {
    throw new Error('BitCider relay returned HTTP ' + response.status + (payload.error ? ' (' + payload.error + ')' : '') + '.');
  }
  return payload;
}

async function callLocalCider(config, job) {
  const allowed = allowedCiderRequest(job);
  if (!allowed) {
    return {
      status: 403,
      payload: { error: { code: 'RELAY_PATH_BLOCKED', message: 'The requested Cider API operation is not allowed by this relay.' } }
    };
  }

  try {
    const response = await fetch(allowed.target, {
      method: allowed.method,
      headers: {
        Accept: 'application/json',
        apptoken: config.ciderToken,
        ...(allowed.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(allowed.body ? { body: JSON.stringify(allowed.body) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: { code: 'CIDER_INVALID_RESPONSE', message: 'Cider returned a non-JSON response.' } }; }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > 220 * 1024) {
      return {
        status: 502,
        payload: { error: { code: 'CIDER_RESPONSE_TOO_LARGE', message: 'Cider returned a response larger than BitCider accepts. Reduce the requested library page size.' } }
      };
    }
    return { status: response.status, payload };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      status: timedOut ? 504 : 503,
      payload: {
        error: {
          code: timedOut ? 'LOCAL_CIDER_TIMEOUT' : 'LOCAL_CIDER_UNAVAILABLE',
          message: timedOut
            ? 'Cider did not respond before the local request deadline.'
            : 'Cider is not reachable at 127.0.0.1:10767. Make sure Cider is running on this computer.'
        }
      }
    };
  }
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    process.stdout.write('\\nBitCider local relay stopping...\\n');
  });
}

async function main() {
  const config = loadConfig();
  process.stdout.write('BitCider local Cider relay\\n');
  process.stdout.write('Config: ' + CONFIG_PATH + '\\n');
  process.stdout.write('Account relay: ' + config.relayUrl + '\\n');
  process.stdout.write('Cider API: local loopback only\\n');
  process.stdout.write('The Cider token stays in this local config and is never logged.\\n');

  try {
    const probe = await fetch(config.ciderApiUrl + '/api/v2/client/info', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    });
    if (!probe.ok) process.stdout.write('Cider health probe returned HTTP ' + probe.status + '; continuing to reconnect.\\n');
    else process.stdout.write('Cider is reachable.\\n');
  } catch {
    process.stdout.write('Cider is not reachable yet. Start Cider; the relay will keep reconnecting.\\n');
  }

  let consecutiveErrors = 0;
  while (!stopping) {
    try {
      const result = await postRelay(config, '/api/relay/next', { waitMs: 20000 });
      consecutiveErrors = 0;
      if (!result.job) continue;
      const response = await callLocalCider(config, result.job);
      await postRelay(config, '/api/relay/respond', {
        jobId: result.job.id,
        status: response.status,
        payload: response.payload
      });
    } catch (error) {
      if (error.fatal) throw error;
      consecutiveErrors += 1;
      const delay = Math.min(10000, 750 * (2 ** Math.min(consecutiveErrors - 1, 4)));
      process.stderr.write('Relay connection issue: ' + error.message + ' Retrying in ' + delay + ' ms.\\n');
      await sleep(delay);
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(error => {
    process.stderr.write('BitCider relay stopped: ' + error.message + '\\n');
    process.exitCode = 1;
  });
}
