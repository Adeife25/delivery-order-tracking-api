import { randomInt } from 'node:crypto';

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

export function generateOrderNumber(now = new Date()): string {
  const datePart = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
    now.getUTCDate(),
  )}`;
  const randomPart = randomInt(0, 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, '0');

  return `ORD-${datePart}-${randomPart}`;
}
