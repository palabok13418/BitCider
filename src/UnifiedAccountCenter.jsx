import { useEffect, useState } from 'react';
import { getUnifiedAccountProductLabel } from './unified-account-center.mjs';
import './unified-account-center.css';

async function readPayload(response) {
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

export default function UnifiedAccountCenterIdentity({
  profile = null,
  createdAt = null,
  bitCiderAuthenticated = false,
  bitConnectionAuthenticated = false
}) {
  const [products, setProducts] = useState({
    bitCider: Boolean(bitCiderAuthenticated),
    bitConnection: Boolean(bitConnectionAuthenticated),
    loading: true
  });
  const [resolvedProfile, setResolvedProfile] = useState(profile);

  useEffect(() => {
    let active = true;

    async function refreshProductStatus() {
      const [ciderResponse, connectionResponse] = await Promise.all([
        fetch('/api/status', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null),
        fetch('/api/bitconnection/account', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null)
      ]);
      const [ciderPayload, connectionPayload] = await Promise.all([
        readPayload(ciderResponse),
        readPayload(connectionResponse)
      ]);
      if (!active) return;

      const nextProducts = {
        bitCider: ciderPayload
          ? ciderPayload.account?.authenticated === true
          : Boolean(bitCiderAuthenticated),
        bitConnection: connectionPayload
          ? connectionPayload.authenticated === true
          : Boolean(bitConnectionAuthenticated),
        loading: false
      };
      setProducts(nextProducts);

      let nextProfile = profile || null;
      if (nextProducts.bitCider && connectionPayload?.bitCiderAccountAvailable) {
        const linkedResponse = await fetch('/api/bitconnection/account', {
          headers: { 'X-BitConnection-Identity': 'bitcider' },
          cache: 'no-store',
          credentials: 'same-origin'
        }).catch(() => null);
        const linkedPayload = await readPayload(linkedResponse);
        if (!nextProfile && linkedPayload?.profile) nextProfile = linkedPayload.profile;
      }
      if (!nextProfile && nextProducts.bitConnection) {
        nextProfile = connectionPayload?.profile || null;
      }
      if (active) setResolvedProfile(nextProfile);
    }

    refreshProductStatus();
    const timer = window.setInterval(refreshProductStatus, 15000);
    const refreshOnFocus = () => refreshProductStatus();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, []);

  useEffect(() => {
    if (profile) setResolvedProfile(profile);
  }, [profile]);

  const accountLabel = getUnifiedAccountProductLabel(products);
  const accountDate = createdAt || resolvedProfile?.createdAt;
  const dateLabel = accountDate
    ? 'Created ' + new Date(accountDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : 'One account center for both products';

  return (
    <div className="unified-account-center-identity" aria-live="polite">
      <div className="unified-account-center-heading">
        <div className="unified-account-center-avatar">
          {resolvedProfile?.avatarDataUrl
            ? <img src={resolvedProfile.avatarDataUrl} alt="" />
            : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4" /><path d="M4.7 20a7.3 7.3 0 0 1 14.6 0" /></svg>}
        </div>
        <div className="unified-account-center-copy">
          <span className="unified-account-center-kicker">UNIFIED ACCOUNT CENTER</span>
          <h2>Account &amp; security</h2>
          <p>{resolvedProfile?.username ? resolvedProfile.username + ' · ' : ''}{dateLabel}</p>
        </div>
      </div>
      <div className="unified-account-center-status">
        <span className="unified-account-center-status-label">SIGNED IN TO</span>
        <strong>{accountLabel}</strong>
      </div>
      <div className="unified-account-center-products" aria-label="Product sign-in status">
        <span className={'unified-account-center-product' + (products.bitCider ? ' is-active' : '')}>
          <i aria-hidden="true" />
          <span>BitCider</span>
          <small>{products.bitCider ? 'Signed in' : 'Not signed in'}</small>
        </span>
        <span className={'unified-account-center-product' + (products.bitConnection ? ' is-active' : '')}>
          <i aria-hidden="true" />
          <span>BitConnection</span>
          <small>{products.bitConnection ? 'Signed in' : 'Not signed in'}</small>
        </span>
      </div>
      {products.bitCider && products.bitConnection && (
        <nav className="unified-account-center-links" aria-label="Product account settings">
          <a href="/?account-center=1" target="_blank" rel="noreferrer">BitCider settings</a>
          <a href="/bitconnection/?account=1&identity=bitconnection" target="_blank" rel="noreferrer">BitConnection settings</a>
        </nav>
      )}
    </div>
  );
}
