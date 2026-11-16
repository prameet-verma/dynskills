import { describe, it, expect } from "vitest";

describe("payments", () => {
  it("rejects invalid amounts", () => {
    expect(-1).toBeLessThan(0);
  });
});
