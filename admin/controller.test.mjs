import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAdminController } from './controller.mjs';

function createHarness() {
  const now = Date.now();
  const ciderStore = {
    accounts: {
      cider_user_private_id: {
        password: { hash: 'not-returned' },
        email: 'private@example.invalid',
        createdAt: new Date(now - 10000).toISOString()
      }
    },
    authSessions: {
      cider_session_hash: {
        accountId: 'cider_user_private_id',
        createdAt: new Date(now - 30000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        deviceName: 'Private device name'
      }
    },
    sessions: {
      pending_cider: { pendingAccountId: 'cider_user_private_id', pendingAccountExpiresAt: now + 300000 }
    },
    webauthnChallenges: {}
  };
  const bitConnectionData = {
    accounts: {
      bc_user_private_id: {
        username: 'Private BitConnection Username',
        password: { hash: 'not-returned' },
        createdAt: new Date(now - 20000).toISOString()
      }
    },
    authSessions: {
      bc_session_hash: {
        accountId: 'bc_user_private_id',
        createdAt: new Date(now - 30000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        deviceName: 'Private browser name'
      }
    },
    profiles: {
      'bitconnection:bc_user_private_id': { username: 'Private BitConnection Username', avatarDataUrl: 'private-image' }
    },
    rooms: {
      private_room_id: {
        hostIdentityId: 'bitconnection:bc_user_private_id',
        status: 'open',
        participants: {
          bc_host: { identityId: 'bitconnection:bc_user_private_id', status: 'connected', credentialHash: 'bc-host-secret' },
          guest: { identityId: 'anonymous-guest', status: 'connected', credentialHash: 'guest-secret' }
        }
      },
      guest_room_id: {
        hostIdentityId: 'another-host',
        status: 'open',
        participants: {
          bc_guest: { identityId: 'bitconnection:bc_user_private_id', status: 'connected', credentialHash: 'bc-guest-secret' },
          host: { identityId: 'another-host', status: 'connected', credentialHash: 'other-host-secret' }
        }
      }
    },
    webauthnChallenges: {}
  };
  const bitConnectionStore = {
    read: () => bitConnectionData,
    update: async mutator => mutator(bitConnectionData),
    createBotAccount: async ({ username, password }) => {
      bitConnectionData.accounts.generated_bot = { username, password, adminBot: true };
      return { ok: true, accountId: 'generated_bot', recoveryCodes: ['1111-2222'] };
    }
  };
  const invalidated = [];
  const controller = createAdminController({
    readCiderStore: () => ciderStore,
    updateCiderStore: async mutator => mutator(ciderStore),
    getBitConnectionStore: () => bitConnectionStore,
    invalidateBrowserBridge: (...args) => invalidated.push(args),
    browserBridges: new Map([['bridge-one', { accountId: 'cider_user_private_id', ownerKey: 'account:cider_user_private_id' }]]),
    createAccountKey: () => crypto.randomBytes(32).toString('base64url'),
    hashAccountKey: value => crypto.createHash('sha256').update(value).digest('hex')
  });
  return { controller, ciderStore, bitConnectionData, invalidated };
}

test('admin user listing returns anonymized product references only', async () => {
  const { controller } = createHarness();
  const users = await controller.listUsers();
  assert.equal(users.length, 2);
  for (const user of users) {
    assert.deepEqual(Object.keys(user).sort(), ['active', 'bot', 'product', 'ref', 'suspended'].sort());
    assert.match(user.ref, /^(CI|BC)-[A-F0-9]{12}$/);
    assert.equal(Object.values(user).some(value => String(value).includes('Private')), false);
  }
  assert.equal(users.find(user => user.product === 'BitCider').active, true);
  assert.equal(users.find(user => user.product === 'BitConnection').active, true);
});

test('suspension revokes active and pending Cider sessions and invalidates its browser bridge', async () => {
  const { controller, ciderStore, invalidated } = createHarness();
  const ciderUser = (await controller.listUsers()).find(user => user.product === 'BitCider');
  const suspended = await controller.setUserSuspended(ciderUser.ref, true);
  assert.equal(suspended.ok, true);
  assert.ok(ciderStore.accounts.cider_user_private_id.suspendedAt);
  assert.equal(Object.keys(ciderStore.authSessions).length, 0);
  assert.equal(Object.keys(ciderStore.sessions).length, 0);
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0][0], 'account:cider_user_private_id');

  const restored = await controller.setUserSuspended(ciderUser.ref, false);
  assert.equal(restored.ok, true);
  assert.equal(ciderStore.accounts.cider_user_private_id.suspendedAt, undefined);
});

test('deleting a BitConnection account removes its profile, sessions, and hosted rooms', async () => {
  const { controller, bitConnectionData } = createHarness();
  const user = (await controller.listUsers()).find(item => item.product === 'BitConnection');
  const result = await controller.deleteUser(user.ref);
  assert.equal(result.ok, true);
  assert.equal(bitConnectionData.accounts.bc_user_private_id, undefined);
  assert.equal(bitConnectionData.profiles['bitconnection:bc_user_private_id'], undefined);
  assert.equal(bitConnectionData.authSessions.bc_session_hash, undefined);
  assert.equal(bitConnectionData.rooms.private_room_id, undefined);
});

test('bot provisioning can create a paired BitCider and BitConnection test identity', async () => {
  const { controller, ciderStore, bitConnectionData } = createHarness();
  const bot = await controller.createBotAccount(['bitcider', 'bitconnection']);
  assert.equal(bot.ok, true);
  assert.equal(bot.products.length, 2);
  assert.match(bot.username, /^Bot[A-Za-z]+[0-9]{4}$/);
  assert.ok(bot.password.length >= 30);
  assert.ok(bot.bitcider.accountKey);
  assert.equal(bot.bitconnection.recoveryCodes.length, 1);
  const ciderBot = Object.values(ciderStore.accounts).find(account => account.adminBot);
  assert.ok(ciderBot);
  assert.equal(ciderBot.ciderToken, undefined);
  assert.equal(bitConnectionData.accounts.generated_bot.adminBot, true);
});

test('suspending a BitConnection account revokes active sessions', async () => {
  const { controller, bitConnectionData } = createHarness();
  const user = (await controller.listUsers()).find(item => item.product === 'BitConnection');
  const result = await controller.setUserSuspended(user.ref, true);
  assert.equal(result.ok, true);
  assert.ok(bitConnectionData.accounts.bc_user_private_id.suspendedAt);
  assert.equal(Object.keys(bitConnectionData.authSessions).length, 0);
  assert.equal(bitConnectionData.rooms.private_room_id.status, 'closed');
  assert.equal(bitConnectionData.rooms.private_room_id.participants.bc_host.status, 'left');
  assert.equal(bitConnectionData.rooms.private_room_id.participants.bc_host.credentialHash, undefined);
  assert.equal(bitConnectionData.rooms.private_room_id.participants.guest.status, 'left');
  assert.equal(bitConnectionData.rooms.guest_room_id.participants.bc_guest.status, 'left');
  assert.equal(bitConnectionData.rooms.guest_room_id.participants.bc_guest.credentialHash, undefined);
  assert.equal(bitConnectionData.rooms.guest_room_id.participants.host.status, 'connected');
  const restored = await controller.setUserSuspended(user.ref, false);
  assert.equal(restored.ok, true);
  assert.equal(bitConnectionData.accounts.bc_user_private_id.suspendedAt, undefined);
});
