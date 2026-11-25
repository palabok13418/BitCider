import express from 'express';

export const BITCONNECTION_API_VERSION = '2026-11-24-foundation-01';

export function bitConnectionHealthPayload() {
  return {
    ok: true,
    service: 'BitConnection',
    apiVersion: BITCONNECTION_API_VERSION,
    deployment: 'Deplexo',
    stage: 'foundation',
    capabilities: {
      roomCreation: 'not-yet-enabled',
      realtimeRooms: 'not-yet-enabled',
      privateRoomVerification: 'not-yet-enabled'
    }
  };
}

export function createBitConnectionRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(bitConnectionHealthPayload());
  });

  return router;
}
