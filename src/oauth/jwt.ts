import { LibertyError } from "../errors.js";

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new LibertyError("Invalid JWT: expected 3 segments.");
  }
  const segment = parts[1];
  if (!segment) {
    throw new LibertyError("Invalid JWT: missing payload segment.");
  }
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  let json: string;
  try {
    json = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new LibertyError("Invalid JWT: payload is not valid base64.");
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new LibertyError("Invalid JWT: payload is not valid JSON.");
  }
}

export function jwtExpiresAt(jwt: string): number {
  const payload = decodeJwtPayload(jwt);
  const exp = payload.exp;
  if (typeof exp !== "number") {
    throw new LibertyError("Invalid JWT: missing or non-numeric 'exp' claim.");
  }
  return exp;
}
