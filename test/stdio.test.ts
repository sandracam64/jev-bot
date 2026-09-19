import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return CallToolResultSchema.parse(result)
    .content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

void test(
  "real stdio server advertises js/reset and runs persistent JavaScript without desktop or TypeSafe access",
  { timeout: 10_000 },
  async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "stdio",
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        TYPESAFE_API_KEY: "",
        CUA_DRIVER_BIN: "/does-not-exist/cua-driver",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "jev-bot-stdio-test", version: "1.0.0" });
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["js", "reset"],
    );
    assert.match(client.getInstructions() ?? "", /persistent JavaScript/);
    const first = await client.callTool({
      name: "js",
      arguments: {
        code: "let value = await Promise.resolve(6); await nodeRepl.write(value);",
        title: "Check the JavaScript session",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(first.isError, true, text(first));
    assert.match(text(first), /Start with await cua.getState/);
    assert.match(text(first), /\n6$/);
    const next = await client.callTool({
      name: "js",
      arguments: {
        code: "value += 2; await nodeRepl.write(value);",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "8");
    const reset = await client.callTool({ name: "reset", arguments: {} });
    assert.notEqual(reset.isError, true, text(reset));
    const afterReset = await client.callTool({
      name: "js",
      arguments: {
        code: "await nodeRepl.write(typeof value);",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(afterReset.isError, true, text(afterReset));
    assert.match(text(afterReset), /\nundefined$/);
  },
);
