import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("project scaffold", () => {
  it("runs the test harness", () => {
    expect(true).toBe(true);
  });

  it("starts the compiled server entrypoint", () => {
    expect(packageJson.scripts.start).toBe("node --env-file-if-exists=.env dist/src/server.js");
  });
});
