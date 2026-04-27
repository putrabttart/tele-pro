import crypto from "crypto";
import { env } from "../config/env";

const algorithm = "aes-256-gcm";
const key = Buffer.from(env.SESSION_ENCRYPTION_KEY.slice(0, 32));

export const encryptText = (plainText: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decryptText = (cipherText: string) => {
  const [ivHex, authTagHex, payloadHex] = cipherText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const payload = Buffer.from(payloadHex, "hex");

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString("utf8");
};
