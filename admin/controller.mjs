import crypto from 'node:crypto';
import { hashSessionId, createPasswordRecord, createRecoveryCodes } from '../account-security.mjs';

const ADJECTIVES = ['Velvet', 'Neon', 'Cosmic', 'Silver', 'Pixel', 'Quiet', 'Golden', 'Static'];
const NOUNS = ['Comet', 'Falcon', 'Otter', 'Orchid', 'Raven', 'Meteor', 'Panda', 'Fox'];

function accountRef(product, accountId) {
  const prefix = product === 'bitconnection' ? 'BC-' : 'CI-';
  return prefix + hashSessionId('BitCider admin account reference v1:' + product + ':' + accountId).slice(0, 12).toUpperCase();
}


function revokeRoomIdentity(data, identityId, { deleteOwnedRooms = false } = {}) {
  const now = new Date().toISOString();
  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    if (!room || typeof room !== 'object') continue;
    const ownsRoom = room.hostIdentityId === identityId;
    if (ownsRoom && deleteOwnedRooms) {
      delete data.rooms[roomId];
      continue;
    }
    let changed = false;
    if (ownsRoom) {
      room.status = 'closed';
      changed = true;
    }
    for (const participant of Object.values(room.participants || {})) {
      if (ownsRoom || participant?.identityId === identityId) {
        participant.status = 'left';
        delete participant.credentialHash;
        participant.lastSeenAt = now;
        changed = true;
      }
    }
    if (changed) room.updatedAt = now;
  }
}

function recentlyActive(sessions, accountId, now) {
  return Object.values(sessions || {}).some(session => (
    session?.accountId === accountId
    && Date.parse(session.expiresAt || 0) > now
    && Date.parse(session.lastSeenAt || session.createdAt || 0) > now - 2 * 60 * 1000
  ));
}

export function createAdminController({
  readCiderStore,
  updateCiderStore,
  getBitConnectionStore,
  invalidateBrowserBridge = () => {},
  browserBridges = new Map(),
  createAccountKey,
  hashAccountKey
} = {}) {
  if (typeof readCiderStore !== 'function' || typeof updateCiderStore !== 'function') {
    throw new TypeError('BitCider admin store methods are required.');
  }

  function rows() {
    const now = Date.now();
    const cider = readCiderStore();
    const connection = getBitConnectionStore?.()?.read?.() || { accounts: {}, authSessions: {} };
    const result = [];
    for (const [id, account] of Object.entries(cider.accounts || {})) {
      result.push({
        ref: accountRef('bitcider', id),
        product: 'BitCider',
        productKey: 'bitcider',
        active: recentlyActive(cider.authSessions, id, now),
        suspended: Boolean(account.suspendedAt),
        bot: account.adminBot === true
      });
    }
    for (const [id, account] of Object.entries(connection.accounts || {})) {
      result.push({
        ref: accountRef('bitconnection', id),
        product: 'BitConnection',
        productKey: 'bitconnection',
        active: recentlyActive(connection.authSessions, id, now),
        suspended: Boolean(account.suspendedAt),
        bot: account.adminBot === true
      });
    }
    return result;
  }

  async function setUserSuspended(ref, suspended) {
    const row = rows().find(item => item.ref === ref);
    if (!row) return { ok: false, status: 404, error: 'USER_NOT_FOUND' };
    const now = new Date().toISOString();

    if (row.productKey === 'bitcider') {
      let targetAccountId = '';
      const result = await updateCiderStore(store => {
        const match = Object.entries(store.accounts || {}).find(([id]) => accountRef('bitcider', id) === ref);
        if (!match) return { ok: false, status: 404, error: 'USER_NOT_FOUND', write: false };
        const [accountId, account] = match;
        targetAccountId = accountId;
        if (suspended) account.suspendedAt = now;
        else delete account.suspendedAt;
        if (suspended) {
          for (const [key, session] of Object.entries(store.authSessions || {})) {
            if (session?.accountId === accountId) delete store.authSessions[key];
          }
          for (const [key, pending] of Object.entries(store.sessions || {})) {
            if (pending?.pendingAccountId === accountId) delete store.sessions[key];
          }
        }
        return { ok: true };
      });
      if (result.ok && suspended) {
        for (const registration of [...browserBridges.values()]) {
          if (registration.accountId === targetAccountId) {
            invalidateBrowserBridge(registration.ownerKey, 'This BitCider account was suspended by the site administrator.');
          }
        }
        const bitConnectionStore = getBitConnectionStore?.();
        await bitConnectionStore?.update?.(data => {
          revokeRoomIdentity(data, 'cider:' + targetAccountId);
          return { ok: true };
        });
      }
      return result;
    }

    const bitConnectionStore = getBitConnectionStore?.();
    if (!bitConnectionStore) return { ok: false, status: 503, error: 'BITCONNECTION_STORE_UNAVAILABLE' };
    return bitConnectionStore.update(data => {
      const match = Object.entries(data.accounts || {}).find(([id]) => accountRef('bitconnection', id) === ref);
      if (!match) return { ok: false, status: 404, error: 'USER_NOT_FOUND', write: false };
      const [accountId, account] = match;
      if (suspended) {
        account.suspendedAt = now;
        for (const [key, session] of Object.entries(data.authSessions || {})) {
          if (session?.accountId === accountId) delete data.authSessions[key];
        }
        revokeRoomIdentity(data, 'bitconnection:' + accountId);
      } else {
        delete account.suspendedAt;
      }
      return { ok: true };
    });
  }

  async function deleteUser(ref) {
    const row = rows().find(item => item.ref === ref);
    if (!row) return { ok: false, status: 404, error: 'USER_NOT_FOUND' };

    if (row.productKey === 'bitcider') {
      let deletedAccountId = '';
      const result = await updateCiderStore(store => {
        const match = Object.entries(store.accounts || {}).find(([id]) => accountRef('bitcider', id) === ref);
        if (!match) return { ok: false, status: 404, error: 'USER_NOT_FOUND', write: false };
        const [accountId] = match;
        deletedAccountId = accountId;
        delete store.accounts[accountId];
        for (const [key, session] of Object.entries(store.authSessions || {})) {
          if (session?.accountId === accountId) delete store.authSessions[key];
        }
        for (const [key, pending] of Object.entries(store.sessions || {})) {
          if (pending?.pendingAccountId === accountId) delete store.sessions[key];
        }
        for (const [key, challenge] of Object.entries(store.webauthnChallenges || {})) {
          if (challenge?.accountId === accountId) delete store.webauthnChallenges[key];
        }
        return { ok: true };
      });
      if (!result.ok) return result;

      for (const registration of [...browserBridges.values()]) {
        if (registration.accountId === deletedAccountId) {
          invalidateBrowserBridge(registration.ownerKey, 'This BitCider account was deleted by the site administrator.');
        }
      }
      const bitConnectionStore = getBitConnectionStore?.();
      await bitConnectionStore?.update?.(data => {
        delete data.profiles['cider:' + deletedAccountId];
        revokeRoomIdentity(data, 'cider:' + deletedAccountId, { deleteOwnedRooms: true });
        return { ok: true };
      });
      return { ok: true };
    }

    const bitConnectionStore = getBitConnectionStore?.();
    if (!bitConnectionStore) return { ok: false, status: 503, error: 'BITCONNECTION_STORE_UNAVAILABLE' };
    return bitConnectionStore.update(data => {
      const match = Object.entries(data.accounts || {}).find(([id]) => accountRef('bitconnection', id) === ref);
      if (!match) return { ok: false, status: 404, error: 'USER_NOT_FOUND', write: false };
      const [accountId] = match;
      delete data.accounts[accountId];
      delete data.profiles['bitconnection:' + accountId];
      for (const [key, session] of Object.entries(data.authSessions || {})) {
        if (session?.accountId === accountId) delete data.authSessions[key];
      }
      for (const [key, challenge] of Object.entries(data.webauthnChallenges || {})) {
        if (challenge?.accountId === accountId) delete data.webauthnChallenges[key];
      }
      revokeRoomIdentity(data, 'bitconnection:' + accountId, { deleteOwnedRooms: true });
      return { ok: true };
    });
  }

  function generateUsername() {
    return 'Bot' + ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]
      + NOUNS[crypto.randomInt(NOUNS.length)]
      + String(crypto.randomInt(1000, 10000));
  }

  async function createBotAccount(products) {
    const username = generateUsername();
    const password = crypto.randomBytes(24).toString('base64url');
    const output = { ok: true, username, password, products: [...products] };

    const bitConnectionStore = getBitConnectionStore?.();
    if (products.includes('bitconnection')) {
      if (!bitConnectionStore?.createBotAccount) {
        return { ok: false, status: 503, error: 'BITCONNECTION_STORE_UNAVAILABLE' };
      }
      const created = await bitConnectionStore.createBotAccount({ username, password });
      if (!created.ok) return { ok: false, status: created.status || 409, error: created.error || 'BOT_USERNAME_TAKEN' };
      output.bitconnection = { recoveryCodes: created.recoveryCodes };
    }

    if (products.includes('bitcider')) {
      if (typeof createAccountKey !== 'function' || typeof hashAccountKey !== 'function') {
        return { ok: false, status: 503, error: 'BITCIDER_ACCOUNT_KEY_SERVICE_UNAVAILABLE' };
      }
      const passwordRecord = await createPasswordRecord(password);
      const recovery = createRecoveryCodes();
      const accountKey = createAccountKey();
      const accountId = crypto.randomBytes(24).toString('base64url');
      const created = await updateCiderStore(store => {
        store.accounts[accountId] = {
          accountKeyHash: hashAccountKey(accountKey),
          password: passwordRecord,
          recoveryCodeHashes: recovery.hashes,
          webAuthnUserId: crypto.randomBytes(32).toString('base64url'),
          passkeys: [],
          createdAt: new Date().toISOString(),
          adminBot: true,
          adminBotLabel: username
        };
        return { ok: true };
      });
      if (!created.ok) {
        if (products.includes('bitconnection')) {
          await bitConnectionStore?.update?.(data => {
            const match = Object.entries(data.accounts || {}).find(([, account]) => account.adminBot === true && account.username === username);
            if (match) {
              const [id] = match;
              delete data.accounts[id];
              delete data.profiles['bitconnection:' + id];
            }
            return { ok: true };
          });
        }
        return { ok: false, status: 500, error: 'BITCIDER_BOT_CREATE_FAILED' };
      }
      output.bitcider = { accountKey, recoveryCodes: recovery.codes };
    }
    return output;
  }

  async function overview() {
    const users = rows();
    const connection = getBitConnectionStore?.()?.read?.() || { rooms: {} };
    const now = Date.now();
    const activeRooms = Object.values(connection.rooms || {}).filter(room =>
      room?.status === 'open' && Date.parse(room.updatedAt || room.createdAt || 0) > now - 10 * 60 * 1000
    ).length;
    return {
      users: users.length,
      activeUsers: users.filter(user => user.active).length,
      suspendedUsers: users.filter(user => user.suspended).length,
      bitCiderAccounts: users.filter(user => user.productKey === 'bitcider').length,
      bitConnectionAccounts: users.filter(user => user.productKey === 'bitconnection').length,
      activeBitCiderUsers: users.filter(user => user.productKey === 'bitcider' && user.active).length,
      activeBitConnectionUsers: users.filter(user => user.productKey === 'bitconnection' && user.active).length,
      activeRooms,
      privacy: 'No usernames, emails, IP addresses, device names, or profile data are returned.'
    };
  }

  return {
    overview,
    listUsers: async () => rows().map(({ ref, product, active, suspended, bot }) => ({
      ref, product, active, suspended, bot
    })),
    setUserSuspended,
    deleteUser,
    createBotAccount
  };
}
