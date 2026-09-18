import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../dist/index.js";
import { parseCliArguments } from "../src/cli-options.js";
import type { Driver } from "../src/types.js";

test("public sessions preserve bindings and own one connection shutdown", async () => {
  let nativeReads = 0;
  let closes = 0;
  const driver: Driver = {
    async listApps() {
      nativeReads++;
      return { apps: [] };
    },
    async listWindows() {
      nativeReads++;
      return { windows: [] };
    },
    async observe() {
      throw new Error("No native observation expected");
    },
    async execute() {
      throw new Error("No native input expected");
    },
    async close() {
      closes++;
    },
  };
  const session = createSession({ driver });
  try {
    const first = await session.execute("let total = 3;", undefined, 1_000);
    assert.notEqual(first.isError, true, JSON.stringify(first));
    assert.equal(nativeReads, 0);
    const next = await session.execute(
      "await nodeRepl.write(total + 4);",
      undefined,
      1_000,
    );
    assert.deepEqual(next.content, [{ type: "text", text: "7" }]);
    await session.execute("await cua.getState();", undefined, 1_000);
    assert.equal(nativeReads, 2);
    await session.reset();
    const cleared = await session.execute(
      "await nodeRepl.write(typeof total);",
      undefined,
      1_000,
    );
    assert(
      cleared.content.some(
        (item) => item.type === "text" && item.text === "undefined",
      ),
    );
  } finally {
    await Promise.all([session.close(), session.close()]);
  }
  assert.equal(closes, 1);
  await assert.rejects(session.execute("1 + 1"), /Session is closed/);
  await assert.rejects(session.reset(), /Session is closed/);
});

test("CLI accepts an explicit environment file without treating its path as a command", () => {
  assert.deepEqual(parseCliArguments([]), { command: "stdio" });
  assert.deepEqual(
    parseCliArguments(["--env-file", "/config/.env", "doctor"]),
    { command: "doctor", envFile: "/config/.env" },
  );
  assert.deepEqual(parseCliArguments(["stdio", "--env-file", "relative.env"]), {
    command: "stdio",
    envFile: "relative.env",
  });
  for (const args of [
    ["--env-file"],
    ["--env-file", ""],
    ["doctor", "stdio"],
    ["--env-file", "a", "--env-file", "b"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseCliArguments(args));
  }
});
