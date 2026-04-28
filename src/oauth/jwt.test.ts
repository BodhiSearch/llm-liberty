import { describe, expect, it } from "vitest";
import { LibertyError } from "../errors.js";
import { decodeJwtPayload, jwtExpiresAt } from "./jwt.js";

function encode(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a base64url-encoded JWT payload", () => {
    const jwt = encode({ sub: "user-123", exp: 1234567890 });
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "user-123", exp: 1234567890 });
  });

  it("rejects JWTs without three segments", () => {
    expect(() => decodeJwtPayload("a.b")).toThrow(LibertyError);
  });

  it("rejects JWTs whose payload isn't valid JSON", () => {
    const bad = `header.${Buffer.from("not-json").toString("base64url")}.sig`;
    expect(() => decodeJwtPayload(bad)).toThrow(LibertyError);
  });
});

describe("jwtExpiresAt", () => {
  it("returns the numeric `exp` claim", () => {
    expect(jwtExpiresAt(encode({ exp: 1700000000 }))).toBe(1700000000);
  });

  it("rejects JWTs without a numeric exp claim", () => {
    expect(() => jwtExpiresAt(encode({ exp: "later" }))).toThrow(LibertyError);
    expect(() => jwtExpiresAt(encode({}))).toThrow(LibertyError);
  });
});
