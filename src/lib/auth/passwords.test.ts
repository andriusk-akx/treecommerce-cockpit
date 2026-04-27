import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("hashPassword + verifyPassword", () => {
  it("round-trips a known password", async () => {
    const hash = await hashPassword("hunter2-test-password");
    expect(hash).not.toBe("hunter2-test-password");
    expect(hash.startsWith("$2")).toBe(true); // bcrypt format
    expect(await verifyPassword("hunter2-test-password", hash)).toBe(true);
  });
  it("rejects wrong passwords", async () => {
    const hash = await hashPassword("correct-horse");
    expect(await verifyPassword("wrong-horse", hash)).toBe(false);
  });
  it("handles empty / corrupted hashes without throwing", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });
  it("rejects too-short passwords on hash", async () => {
    await expect(hashPassword("")).rejects.toThrow();
    await expect(hashPassword("ab")).rejects.toThrow();
  });
  it("two hashes of the same password differ (salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    // But both verify against the same plaintext.
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });
});
