import { describe, it, expect } from "vitest";
import { extractToken, hashToken } from "../src/auth.js";

describe("auth", () => {
  it("extracts bearer or x-api-key", () => {
    expect(extractToken({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractToken({ "x-api-key": "k" })).toBe("k");
    expect(extractToken({ authorization: "Bearer abc", "x-api-key": "k" })).toBe("abc");
    expect(extractToken({})).toBeUndefined();
  });
  it("hashes deterministically with sha256 hex", () => {
    expect(hashToken("cgw_test")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("cgw_test")).toBe(hashToken("cgw_test"));
  });
});
