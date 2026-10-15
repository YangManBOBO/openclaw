import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";

const CONTAINER_ENV = { OPENCLAW_CONTAINER_HINT: "demo" };
const PROFILE_ENV = { OPENCLAW_PROFILE: "work" };

describe("formatCliCommand", () => {
  it("inserts the container flag after a plain binary invocation", () => {
    expect(formatCliCommand("openclaw doctor --fix", CONTAINER_ENV)).toBe(
      "openclaw --container demo doctor --fix",
    );
    expect(formatCliCommand("npx openclaw doctor --fix", CONTAINER_ENV)).toBe(
      "npx openclaw --container demo doctor --fix",
    );
  });

  it("inserts the profile flag after a plain binary invocation", () => {
    expect(formatCliCommand("openclaw doctor --fix", PROFILE_ENV)).toBe(
      "openclaw --profile work doctor --fix",
    );
  });

  it("leaves version-suffixed invocations unchanged instead of mangling them", () => {
    expect(formatCliCommand("npx openclaw@latest gateway status --deep", CONTAINER_ENV)).toBe(
      "npx openclaw@latest gateway status --deep",
    );
    expect(formatCliCommand("openclaw@latest gateway status --deep", CONTAINER_ENV)).toBe(
      "openclaw@latest gateway status --deep",
    );
    expect(formatCliCommand("openclaw-update", CONTAINER_ENV)).toBe("openclaw-update");
  });

  it("leaves non-CLI commands unchanged", () => {
    expect(formatCliCommand("claude auth login", CONTAINER_ENV)).toBe("claude auth login");
  });
});
