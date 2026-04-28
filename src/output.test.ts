import { describe, expect, it } from "vitest";
import { BEARER_AUTH, type CurlExample, renderCurl } from "./output.js";

describe("BEARER_AUTH", () => {
  it("is the canonical Authorization: Bearer spec", () => {
    expect(BEARER_AUTH).toEqual({ in: "header", key: "Authorization", scheme: "Bearer" });
  });
});

describe("renderCurl", () => {
  it("renders a runnable POST curl with quoted headers and a JSON body", () => {
    const example: CurlExample = {
      method: "POST",
      url: "https://api.example.com/v1/messages",
      headers: {
        Authorization: "Bearer sk-test-token",
        "content-type": "application/json",
      },
      body: { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
    };

    const out = renderCurl(example);

    expect(out).toContain("curl -X POST 'https://api.example.com/v1/messages'");
    expect(out).toContain("-H 'Authorization: Bearer sk-test-token'");
    expect(out).toContain("-H 'content-type: application/json'");
    expect(out).toContain("--data-raw");
    expect(out).toContain('"model": "claude-haiku"');
  });

  it("escapes single quotes inside body fields safely for shell", () => {
    const example: CurlExample = {
      method: "POST",
      url: "https://api.example.com/x",
      headers: {},
      body: { system: "You are Codex, OpenAI's coding agent." },
    };

    const out = renderCurl(example);

    expect(out).toContain("OpenAI'\\''s");
    expect(out).not.toMatch(/OpenAI's/);
  });
});
