import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('Account Center button is only rendered for an active signed-in identity', async () => {
  const source = await fs.readFile(path.join(ROOT, '..', 'src', 'BitConnection.jsx'), 'utf8');

  assert.ok(source.includes("const [accountAvailable, setAccountAvailable] = useState(false);"));
  assert.ok(source.includes("fetch('/api/bitconnection/account'"));
  assert.ok(source.includes('Boolean(payload.authenticated || payload.bitCiderAccountAvailable)'));
  assert.match(
    source,
    /\{accountAvailable && \(\s*<button className="bitconnection-account-button"/
  );
  assert.ok(source.includes('window.setInterval(refreshAccountAvailability, 15000)'));
  assert.ok(source.includes("window.addEventListener('focus', refreshOnFocus)"));
});
