import { NextApiRequest, NextApiResponse } from "next";

import {
  cookieValue,
  credentialFromCookie,
  diagnosticsCookieCleanup,
  diagnosticsCookieName,
  verifyCapability,
} from "@/lib/server/incidentAuth";
import { parseIncident } from "@/lib/server/incidentSchema";
import { rememberIncident } from "@/lib/server/incidentStore";

export const config = {
  api: { bodyParser: { sizeLimit: "64kb" } },
};

function noStore(res: NextApiResponse): void {
  res.setHeader("Cache-Control", "no-store");
}

function room(value: unknown): value is string {
  return typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,256}$/.test(value);
}

function sameOrigin(req: NextApiRequest): boolean {
  const supplied = req.headers.origin;
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0] || req.headers.host;
  if (!supplied || !host || Array.isArray(supplied)) return false;
  const forwarded = req.headers["x-forwarded-proto"];
  const forwardedProtocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0];
  const protocol = forwardedProtocol === "http" || (!forwardedProtocol && /^(localhost|127\.0\.0\.1)(:|$)/.test(host))
    ? "http" : "https";
  return supplied === `${protocol}://${host}`;
}

function bearer(req: NextApiRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header) || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice("Bearer ".length);
  return value || undefined;
}

function bodyTooLarge(req: NextApiRequest): boolean {
  const header = req.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^\d+$/.test(value)) return false;
  return Number(value) > 64 * 1024;
}

function unauthorized(res: NextApiResponse): void {
  res.status(401).json({ message: "diagnostics credential required" });
}

export default function handleIncidents(req: NextApiRequest, res: NextApiResponse): void {
  noStore(res);
  if (req.method === "GET") {
    const requested = Array.isArray(req.query.room) ? undefined : req.query.room;
    if (!room(requested)) {
      res.status(400).json({ message: "valid room is required" });
      return;
    }
    const cookie = cookieValue(req.headers.cookie, diagnosticsCookieName(requested));
    const credential = credentialFromCookie(requested, cookie);
    if (!credential) {
      unauthorized(res);
      return;
    }
    const cleanup = diagnosticsCookieCleanup(req.headers.cookie, diagnosticsCookieName(requested));
    if (cleanup.length) res.setHeader("Set-Cookie", cleanup);
    res.status(200).json({ credential, room: requested, serverTime: new Date().toISOString() });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ message: "method not allowed" });
    return;
  }
  if (!sameOrigin(req)) {
    res.status(403).json({ message: "invalid origin" });
    return;
  }
  if (bodyTooLarge(req)) {
    res.status(413).json({ message: "incident report is too large" });
    return;
  }
  const incident = parseIncident(req.body);
  if (!incident) {
    res.status(400).json({ message: "invalid incident report" });
    return;
  }
  if (!verifyCapability(bearer(req), "credential", incident.room)) {
    unauthorized(res);
    return;
  }
  const result = rememberIncident(incident);
  if (result === "rate_limited") {
    res.status(429).json({ message: "incident rate limit reached" });
    return;
  }
  if (result === "collision") {
    res.status(409).json({ message: "incident id is already bound to another room" });
    return;
  }
  if (result === "accepted") {
    // Cloud Logging ingests this JSON directly in Firebase/App Hosting. This is
    // intentionally the entire report schema, never a media, transcript, ICE
    // candidate, LiveKit token, cookie, or user-provided text field.
    console.info(JSON.stringify({
      severity: "INFO",
      event: "avatar_freeze_incident",
      serverReceivedAt: new Date().toISOString(),
      ...incident,
    }));
  }
  res.status(200).json({ id: incident.id, stored: true, duplicate: result === "duplicate" });
}
