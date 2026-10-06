import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Match the bounded seven-day Serverless job ceiling. These are telemetry-only,
// room-scoped capabilities: they cannot join LiveKit or mint media credentials.
// The browser's local pending-report queue has its own shorter retention policy.
export const DIAGNOSTICS_COOKIE_TTL_S = 7 * 24 * 60 * 60;
export const DIAGNOSTICS_CREDENTIAL_TTL_S = 7 * 24 * 60 * 60;

type CapabilityKind = "cookie" | "credential";

export type DiagnosticsCapability = {
  readonly version: 1;
  readonly kind: CapabilityKind;
  readonly room: string;
  readonly exp: number;
  readonly nonce: string;
};

type CookieMetadata = { name: string; exp: number };

function secret(): string {
  const value = process.env.LIVEKIT_API_SECRET;
  if (!value) throw new Error("LIVEKIT_API_SECRET is required for diagnostics capabilities");
  return value;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signature(kind: CapabilityKind, payload: string): string {
  return createHmac("sha256", secret())
    .update(`livekit-avatar/diagnostics/${kind}/v1\u0000${payload}`, "utf8")
    .digest("base64url");
}

function isCapability(value: unknown, kind: CapabilityKind): value is DiagnosticsCapability {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && candidate.kind === kind && typeof candidate.room === "string" &&
    candidate.room.length > 0 && candidate.room.length <= 256 && typeof candidate.exp === "number" &&
    Number.isSafeInteger(candidate.exp) && typeof candidate.nonce === "string" && candidate.nonce.length >= 16;
}

export function diagnosticsCookieName(room: string): string {
  // The cookie namespace reveals neither the room name nor an identity.
  return `lkdiag_${createHash("sha256").update(room, "utf8").digest("base64url").slice(0, 30)}`;
}

export function mintCapability(room: string, kind: CapabilityKind, ttlS: number, now = Date.now()): string {
  const payload: DiagnosticsCapability = {
    version: 1,
    kind,
    room,
    exp: Math.floor(now / 1000) + ttlS,
    nonce: randomUUID(),
  };
  const encoded = encode(payload);
  return `${encoded}.${signature(kind, encoded)}`;
}

export function verifyCapability(token: string | undefined, kind: CapabilityKind, room: string, now = Date.now()): boolean {
  if (!token || token.length > 4096 || token.split(".").length !== 2) return false;
  const [encoded, supplied] = token.split(".");
  const expected = signature(kind, encoded);
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return false;
  try {
    const payload = decode(encoded);
    return isCapability(payload, kind) && payload.room === room && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

export function diagnosticsCookie(room: string, now = Date.now(), secure = process.env.NODE_ENV === "production"): string {
  const name = diagnosticsCookieName(room);
  const value = mintCapability(room, "cookie", DIAGNOSTICS_COOKIE_TTL_S, now);
  const attributes = [
    `${name}=${value}`,
    "Path=/api/incidents",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DIAGNOSTICS_COOKIE_TTL_S}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function credentialFromCookie(room: string, cookie: string | undefined, now = Date.now()): string | undefined {
  if (!verifyCapability(cookie, "cookie", room, now)) return undefined;
  return mintCapability(room, "credential", DIAGNOSTICS_CREDENTIAL_TTL_S, now);
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookieEntries(header: string | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  const result: Array<{ name: string; value: string }> = [];
  for (const entry of header.split(";")) {
    const [name, ...parts] = entry.trim().split("=");
    if (!name || !parts.length) continue;
    try {
      result.push({ name, value: decodeURIComponent(parts.join("=")) });
    } catch {
      // Ignore malformed untrusted cookie values.
    }
  }
  return result;
}

function verifiedCookieExpiry(value: string, now: number): number | undefined {
  if (value.length > 4096 || value.split(".").length !== 2) return undefined;
  const [encoded] = value.split(".");
  try {
    const payload = decode(encoded);
    if (!isCapability(payload, "cookie") || !verifyCapability(value, "cookie", payload.room, now)) return undefined;
    return payload.exp;
  } catch {
    return undefined;
  }
}

function expiredCookie(name: string, secure: boolean): string {
  const attributes = [`${name}=`, "Path=/api/incidents", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Keep the active room and at most seven newest verified room cookies. */
export function diagnosticsCookieCleanup(
  header: string | undefined,
  currentName: string,
  now = Date.now(),
  secure = process.env.NODE_ENV === "production",
): string[] {
  const nowS = Math.floor(now / 1000);
  const candidates: CookieMetadata[] = cookieEntries(header)
    .filter(({ name }) => name.startsWith("lkdiag_"))
    .map(({ name, value }) => ({ name, exp: verifiedCookieExpiry(value, now) }))
    .filter((entry): entry is CookieMetadata => entry.exp !== undefined && entry.exp > nowS);
  const keep = new Set([currentName]);
  candidates
    .filter((entry) => entry.name !== currentName)
    .sort((left, right) => right.exp - left.exp)
    .slice(0, 7)
    .forEach((entry) => keep.add(entry.name));
  return cookieEntries(header)
    .map(({ name }) => name)
    .filter((name) => name.startsWith("lkdiag_") && !keep.has(name))
    .map((name) => expiredCookie(name, secure));
}
