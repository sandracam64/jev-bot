import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ReplRuntimePort } from "../src/server.js";

function stubRuntime(
  overrides: Partial<ReplRuntimePort> = {},
): ReplRuntimePort {
  return {
    execute: async () => ({
      content: [{ type: "text", text: "Observed current state." }],
    }),
    reset: async () => {},
    ...overrides,
  };
}

async function connect(
  t: TestContext,
  runtime: ReplRuntimePort,
): Promise<Client> {
  const server = createServer(runtime);
  const client = new Client({ name: "jev-bot-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

void test("publishes only js and reset with strict schemas and conservative action annotations", async (t) => {
  const client = await connect(t, stubRuntime());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["js", "reset"],
  );
  for (const tool of tools)
    assert.equal(tool.inputSchema.additionalProperties, false);
  const js = tools.find((tool) => tool.name === "js");
  assert.deepEqual(js?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(js?.inputSchema.required, ["code"]);
  const guidance = client.getInstructions()?.slice(0, 512) ?? "";
  assert.match(guidance, /cua.getState/);
  assert.match(guidance, /app.act/);
  assert.match(guidance, /DONE is not verified success/);
});

void test("dispatches exact JavaScript, timeout, and cancellation signal and preserves rich output", async (t) => {
  const emitted: CallToolResult = {
    content: [
      { type: "text", text: "Window observation." },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    structuredContent: { status: "handoff" },
  };
  const calls: Array<{
    code: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = [];
  const client = await connect(
    t,
    stubRuntime({
      execute: async (code, signal, timeoutMs) => {
        calls.push({ code, signal, timeoutMs });
        return emitted;
      },
    }),
  );
  const code =
    'let app = await cua.getApp("TextEdit");\nawait app.getAXState();';
  const response = await client.callTool({
    name: "js",
    arguments: { code, title: "Read the editor", timeout_ms: 1_234 },
  });
  assert.deepEqual(response, emitted);
  assert.equal(calls[0]?.code, code);
  assert.equal(calls[0]?.timeoutMs, 1_234);
  assert.ok(calls[0]?.signal instanceof AbortSignal);
  assert.equal(calls[0].signal.aborted, false);
  await client.callTool({
    name: "js",
    arguments: { code: "await cua.getState()" },
  });
  assert.equal(calls[1]?.timeoutMs, 30_000);
});

void test("rejects invalid and unknown arguments before executing JavaScript", async (t) => {
  let calls = 0;
  const client = await connect(
    t,
    stubRuntime({
      execute: async () => {
        calls++;
        return { content: [] };
      },
      reset: async () => {
        calls++;
      },
    }),
  );
  const invalid = [
    {},
    { code: "" },
    { code: "   " },
    { code: "await cua.getState()", unexpected: true },
    { code: "await cua.getState()", timeout_ms: 0 },
    { code: "await cua.getState()", timeout_ms: 60_001 },
    { code: "await cua.getState()", timeout_ms: 1.5 },
    { code: "await cua.getState()", title: "" },
  ];
  for (const args of invalid) {
    const response = await client.callTool({ name: "js", arguments: args });
    assert.equal(response.isError, true, JSON.stringify(args));
  }
  const reset = await client.callTool({
    name: "reset",
    arguments: { force: true },
  });
  assert.equal(reset.isError, true);
  assert.equal(calls, 0);
});

void test("delegates reset to the same persistent runtime without executing code", async (t) => {
  let resets = 0;
  const client = await connect(
    t,
    stubRuntime({
      execute: async () => {
        throw new Error("Reset must not execute user code.");
      },
      reset: async () => {
        resets++;
      },
    }),
  );
  const response = await client.callTool({ name: "reset", arguments: {} });
  assert.equal(resets, 1);
  assert.deepEqual(response.structuredContent, { reset: true });
  assert.notEqual(response.isError, true);
});

void test("passes runtime handoff and error outcomes through without relabeling success", async (t) => {
  let outcome: CallToolResult = {
    content: [{ type: "text", text: "Visual fallback required." }],
    structuredContent: { status: "handoff" },
  };
  const client = await connect(
    t,
    stubRuntime({ execute: async () => outcome }),
  );
  for (const error of [false, true]) {
    outcome = { ...outcome, isError: error };
    const response = await client.callTool({
      name: "js",
      arguments: { code: 'await app.act("Open preferences")' },
    });
    assert.deepEqual(response, outcome);
  }
});

void test("does not leak underlying runtime exception details", async (t) => {
  const fail = async (): Promise<never> => {
    throw new Error("secret-api-key and private response body");
  };
  const client = await connect(t, stubRuntime({ execute: fail, reset: fail }));
  for (const name of ["js", "reset"]) {
    const response = await client.callTool({
      name,
      arguments: name === "js" ? { code: "await cua.getState()" } : {},
    });
    assert.equal(response.isError, true);
    assert.doesNotMatch(
      JSON.stringify(response),
      /secret-api-key|private response body/,
    );
  }
});

void test("cancels an in-flight execution through the MCP request signal", async (t) => {
  let markStarted: () => void = () => {};
  let markAborted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const client = await connect(
    t,
    stubRuntime({
      execute: async (_code, signal) => {
        assert.ok(signal);
        const cancellation = new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              markAborted();
              resolve();
            },
            { once: true },
          );
        });
        markStarted();
        await cancellation;
        return { content: [{ type: "text", text: "Cancelled by caller." }] };
      },
    }),
  );
  const controller = new AbortController();
  const pending = client.callTool(
    { name: "js", arguments: { code: 'await app.act("Open preferences")' } },
    undefined,
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending, /cancelled by test/);
  await started;
  controller.abort(new Error("cancelled by test"));
  await rejected;
  await aborted;
});
