import { createHash, randomUUID } from 'node:crypto';

export const newId = () => randomUUID();

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const now = () => Date.now();
