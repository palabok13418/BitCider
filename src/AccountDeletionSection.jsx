import { useEffect, useState } from 'react';
import './account-deletion.css';

async function clearThisOriginData() {
  try { window.localStorage.clear(); } catch {}
  try { window.sessionStorage.clear(); } catch {}
  try {
    if ('caches' in window) {
      const names = await window.caches.keys();
      await Promise.all(names.map(name => window.caches.delete(name)));
    }
  } catch {}
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(item => item.unregister()));
    }
  } catch {}
}

export default function AccountDeletionSection({
  status = null,
  csrfToken = '',
  onDeleted = null,
  productLabel = 'BitCider'
}) {
  const [liveStatus, setLiveStatus] = useState(null);
  const [liveCsrfToken, setLiveCsrfToken] = useState('');
  const [checking, setChecking] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('Preparing account deletion');
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadStatus() {
      try {
        const response = await fetch('/api/status', {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Could not check the BitCider session.');
        if (!active) return;
        setLiveStatus(payload);
        setLiveCsrfToken(typeof payload.csrfToken === 'string' ? payload.csrfToken : '');
      } catch {
        if (active) setLiveStatus({ account: { authenticated: false } });
      } finally {
        if (active) setChecking(false);
      }
    }
    void loadStatus();
    return () => { active = false; };
  }, []);

  const account = liveStatus?.account || status?.account || {};
  const authenticated = account.authenticated === true;
  const token = liveCsrfToken || csrfToken;

  function closeDialog() {
    if (busy) return;
    setDialogOpen(false);
    setConfirmation('');
    setError('');
  }

  async function deleteAccount() {
    if (!authenticated) {
      setError('Sign in to your BitCider account before deleting it.');
      return;
    }
    if (!token) {
      setError('The security token is unavailable. Refresh BitAccount Center and try again.');
      return;
    }
    if (confirmation.trim() !== 'DELETE') {
      setError('Type DELETE exactly to confirm permanent account removal.');
      return;
    }

    setBusy(true);
    setError('');
    setProgress(4);
    setProgressLabel('Opening the secure deletion process');

    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-BitCider-CSRF': token,
          Accept: 'text/event-stream'
        },
        cache: 'no-store',
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Account deletion could not be started.');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('This browser could not read the account deletion status.');
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        if (done && buffer.trim()) blocks.push(buffer);

        for (const block of blocks) {
          const dataLine = block.split(/\r?\n/).find(line => line.startsWith('data:'));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(5).trim());
          if (typeof event.progress === 'number') setProgress(event.progress);
          if (event.label) setProgressLabel(event.label);
          if (event.type === 'error') throw new Error(event.label || 'Account deletion was interrupted.');
          if (event.type === 'complete') completed = true;
        }
        if (done) break;
      }

      if (!completed) throw new Error('The server closed the deletion process before confirming completion.');
      setProgress(100);
      setProgressLabel('BitCider account permanently deleted');
      await clearThisOriginData();
      setComplete(true);
      setDialogOpen(false);
      setConfirmation('');
      window.dispatchEvent(new Event('focus'));
      if (typeof onDeleted === 'function') await onDeleted();
    } catch (deleteError) {
      setError(deleteError.message || 'Account deletion failed. Your account may still be active.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bitaccount-delete-card" aria-labelledby="bitaccount-delete-title">
      <div className="bitaccount-delete-copy">
        <span className="bitaccount-delete-kicker">ACCOUNT OWNERSHIP</span>
        <strong id="bitaccount-delete-title">Delete BitCider account</strong>
        <p>
          Permanently removes the BitCider account, its saved Cider connection,
          passkeys, recovery codes, Account Key, and BitCider device sessions.
          Your separate BitConnection account is not deleted.
        </p>
        {checking && <small className="bitaccount-delete-state">Checking BitCider sign-in…</small>}
        {!checking && !authenticated && !complete && (
          <small className="bitaccount-delete-state">Sign in to BitCider in this browser to manage its deletion here.</small>
        )}
        {complete && (
          <small className="bitaccount-delete-complete" role="status">
            BitCider account deleted. Your separate BitConnection account remains intact.
          </small>
        )}
      </div>
      {!complete && (
        <button
          className="bitaccount-delete-button"
          type="button"
          onClick={() => { setDialogOpen(true); setError(''); }}
          disabled={checking || !authenticated || busy}
        >
          Delete BitCider account
        </button>
      )}

      {dialogOpen && (
        <div className="bitaccount-delete-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeDialog(); }}>
          <section className="bitaccount-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="bitaccount-delete-dialog-title">
            <span className="bitaccount-delete-kicker">PERMANENT ACTION</span>
            <h3 id="bitaccount-delete-dialog-title">{busy ? 'Deleting your BitCider account' : 'Are you sure?'}</h3>
            {busy ? (
              <>
                <p>{progressLabel}</p>
                <div className="bitaccount-delete-progress" role="progressbar" aria-label="Account deletion progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                  <i style={{ width: progress + '%' }} />
                </div>
                <small>{Math.round(progress)}%</small>
              </>
            ) : (
              <>
                <p>This cannot be undone. Your BitConnection account will remain active.</p>
                <label className="bitaccount-delete-confirm-label">
                  Type <strong>DELETE</strong> to confirm
                  <input
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Type DELETE"
                    aria-label="Type DELETE to confirm account deletion"
                  />
                </label>
                {error && <p className="bitaccount-delete-error" role="alert">{error}</p>}
                <div className="bitaccount-delete-dialog-actions">
                  <button type="button" onClick={closeDialog}>Cancel</button>
                  <button type="button" onClick={() => void deleteAccount()} disabled={confirmation.trim() !== 'DELETE'}>
                    Permanently delete
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
