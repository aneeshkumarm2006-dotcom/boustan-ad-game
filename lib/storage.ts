/**
 * localStorage wrapper. The game uses no cookies (PRD EMB-07): preferences, the player token
 * and the local best live here. Storage can be missing or throw (private mode, blocked
 * third-party storage in an iframe), so every call degrades to "nothing saved".
 */

const PREFIX = "bstn:";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readString(key: string): string | null {
  try {
    return storage()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, value);
  } catch {
    // Full or blocked: the game keeps working without persistence.
  }
}

export function readJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  const raw = readString(key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeString(key, value === null || value === undefined ? null : JSON.stringify(value));
}
