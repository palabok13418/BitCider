export function getUnifiedAccountProductLabel({ bitCider = false, bitConnection = false } = {}) {
  if (bitCider && bitConnection) return 'Both';
  if (bitCider) return 'BitCider';
  if (bitConnection) return 'BitConnection';
  return 'No active account';
}
