import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const encryptionKey = Buffer.from(config.UID_ENCRYPTION_KEY, 'hex');

export function protectUid(uid: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(uid, 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    hash: createHmac('sha256', config.UID_HMAC_KEY).update(uid).digest('hex')
  };
}

export function revealUid(cipherText: string, iv: string, tag: string) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'hex')), decipher.final()]).toString('utf8');
}

export function maskUid(uid: string) {
  return `${'*'.repeat(Math.max(0, uid.length - 4))}${uid.slice(-4)}`;
}
