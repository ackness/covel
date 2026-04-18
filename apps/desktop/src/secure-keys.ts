/**
 * Secure storage for LLM provider API keys.
 *
 * Uses Electron's `safeStorage` (macOS Keychain, Windows DPAPI, Linux
 * libsecret) to encrypt the keys at rest. Ciphertext is written to
 * `<userData>/config/keys.enc` so the keys live with the rest of the
 * user's data and can be included in a backup export.
 *
 * Fallback: when `safeStorage.isEncryptionAvailable()` returns false (e.g.
 * fresh Linux install without libsecret), we DELIBERATELY refuse to fall
 * back to plaintext on disk. The renderer will get an empty record and
 * fall back to its in-memory cache / localStorage path.
 */

import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import { userConfigDir } from "./paths.js";

function keysFile(): string {
  return path.join(userConfigDir(), "keys.enc");
}

export function keysEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function loadKeys(): Record<string, string> {
  if (!keysEncryptionAvailable()) return {};
  const file = keysFile();
  if (!fs.existsSync(file)) return {};
  try {
    const buf = fs.readFileSync(file);
    const plain = safeStorage.decryptString(buf);
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch (err) {
    console.warn("[secure-keys] decrypt failed:", err);
    return {};
  }
}

export function saveKeys(keys: Record<string, string>): boolean {
  if (!keysEncryptionAvailable()) return false;
  try {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
    }
    const enc = safeStorage.encryptString(JSON.stringify(cleaned));
    fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
    fs.writeFileSync(keysFile(), enc, { mode: 0o600 });
    return true;
  } catch (err) {
    console.error("[secure-keys] encrypt failed:", err);
    return false;
  }
}
