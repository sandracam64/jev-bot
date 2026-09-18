import assert from "node:assert/strict";
import test from "node:test";

import {
  createDriver,
  createDriverSchemaValidator,
  normalizeObservation,
  normalizeReceipt,
  type DriverClient,
} from "../src/driver.js";
import type { JsonObject } from "../src/types.js";

const target = { pid: 42, windowId: 12 };
const session = "test-session";
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const common = {
  session: str,
  delivery_mode: { type: "string", enum: ["background", "foreground"] },
};

function tool(name: string, properties: JsonObject, required: string[] = []) {
  return {
    name,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function tools() {
  return [
    tool("list_apps", {}),
    tool("list_windows", { pid: int, on_screen_only: bool }),
    tool(
      "get_window_state",
      {
        pid: int,
        window_id: int,
        session: str,
        query: str,
        include_screenshot: bool,
        include_accessibility_tree: bool,
        max_elements: int,
      },
      ["pid", "window_id"],
    ),
    tool(
      "click",
      { ...common, target: { type: "object" }, element_token: str },
      ["target", "delivery_mode"],
    ),
    tool(
      "type_text",
      { ...common, pid: int, window_id: int, element_token: str, text: str },
      ["text"],
    ),
    tool(
      "set_value",
      {
        session: str,
        pid: int,
        window_id: int,
        element_token: str,
        value: str,
      },
      ["pid", "value"],
    ),
    tool("press_key", { ...common, pid: int, window_id: int, key: str }, [
      "key",
    ]),
  ];
}

function state(): JsonObject {
  return {
    pid: 42,
    window_id: 12,
    snapshot_id: "s00000001",
    app_name: "Calculator",
    window_title: "Calculator",
    elements_complete: true,
    degraded: false,
    elements: [
      {
        element_index: 0,
        element_token: "s00000001:0",
        role: "AXButton",
        label: "7",
        enabled: true,
        actions: ["AXPress"],
        in_web_content: false,
      },
    ],
  };
}

function fake(
  inventory = tools(),
  result: unknown = { structuredContent: state() },
) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  let closed = 0;
  const client: DriverClient = {
    async listTools() {
      return { tools: inventory };
    },
    async callTool(call) {
      calls.push(call);
      return result;
    },
    async close() {
      closed += 1;
    },
  };
  return { client, calls, closed: () => closed };
}

test("observation requests the exact window, bounded accessibility and no screenshot", async () => {
  const fixture = fake();
  const driver = await createDriver(fixture.client, session);
  const observed = await driver.observe(target, "7");
  assert.equal(observed.elements[0]?.token, "s00000001:0");
  assert.equal(observed.complete, false);
  assert.deepEqual(fixture.calls, [
    {
      name: "get_window_state",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        query: "7",
        include_screenshot: false,
        include_accessibility_tree: true,
        max_elements: 256,
      },
    },
  ]);
  await driver.close();
  await driver.close();
  assert.equal(fixture.closed(), 1);
  await assert.rejects(driver.observe(target), /closed/);
});

test("discovery does not leak unsupported session fields and returns bounded metadata", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      windows: [
        {
          pid: 42,
          window_id: 12,
          app_name: "App",
          title: "Title",
          is_on_screen: true,
          unexpected: "not returned",
        },
      ],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.listWindows(), {
    windows: [
      {
        pid: 42,
        window_id: 12,
        app_name: "App",
        title: "Title",
        is_on_screen: true,
      },
    ],
  });
  assert.deepEqual(fixture.calls[0]?.arguments, {});
});

test("click uses canonical target while typing and keys use advertised native flat fields", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      effect: "confirmed",
      route: "accessibility",
      delivery: { mode: "background" },
      evidence: [{ kind: "value_readback" }],
    },
  });
  const driver = await createDriver(fixture.client, session);
  const click = await driver.execute({
    kind: "click",
    target,
    elementToken: "s00000001:0",
  });
  assert.equal(click.executed, true);
  await driver.execute({
    kind: "type_text",
    target,
    elementToken: "s00000001:1",
    text: "hello",
  });
  await driver.execute({ kind: "press_key", target, key: "return" });
  assert.deepEqual(
    fixture.calls.map((call) => call.arguments),
    [
      {
        target: { kind: "window", pid: 42, window_id: 12 },
        session,
        delivery_mode: "background",
        element_token: "s00000001:0",
      },
      {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        element_token: "s00000001:1",
        text: "hello",
      },
      {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        key: "return",
      },
    ],
  );
});

test("refuses portable typing contract lacking snapshot token targeting before mutation", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "type_text"
      ? tool("type_text", { ...common, target: { type: "object" }, text: str })
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({
      kind: "type_text",
      target,
      elementToken: "s00000001:1",
      text: "private",
    }),
    /required safe input contract/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("refuses missing background mode and undocumented required fields without calls", async () => {
  for (const replacement of [
    tool("click", {
      session: str,
      target: { type: "object" },
      element_token: str,
    }),
    tool(
      "click",
      { ...common, target: { type: "object" }, element_token: str },
      ["unknown_field"],
    ),
  ]) {
    const fixture = fake(
      tools().map((entry) => (entry.name === "click" ? replacement : entry)),
    );
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(
      driver.execute({ kind: "click", target, elementToken: "s00000001:0" }),
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test("never retries actions or exposes raw error content", async () => {
  const fixture = fake();
  fixture.client.callTool = async (call) => {
    fixture.calls.push(call);
    throw new Error("sensitive token from transport");
  };
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({ kind: "click", target, elementToken: "s00000001:0" }),
    { message: "Driver request failed; its outcome is unknown" },
  );
  assert.equal(fixture.calls.length, 1);
});

test("wrong-window, unsafe IDs, duplicate tokens and malformed snapshot fields fail closed", () => {
  assert.throws(() =>
    normalizeObservation({ ...state(), window_id: 999 }, target),
  );
  assert.throws(() =>
    normalizeObservation(state(), {
      ...target,
      windowId: Number.MAX_SAFE_INTEGER + 1,
    }),
  );
  assert.throws(() =>
    normalizeObservation({ ...state(), snapshot_id: undefined }, target),
  );
  assert.throws(() =>
    normalizeObservation(
      {
        ...state(),
        elements: [
          { element_index: 0, element_token: "duplicate", role: "AXButton" },
          { element_index: 1, element_token: "duplicate", role: "AXButton" },
        ],
      },
      target,
    ),
  );
  assert.throws(() =>
    normalizeObservation({ ...state(), degraded: "false" }, target),
  );
});

test("secure elements and raw tree content never reach normalized observations", () => {
  const result = normalizeObservation(
    {
      ...state(),
      tree_markdown: "password secret",
      elements: [
        {
          element_index: 0,
          role: "AXSecureTextField",
          label: "Account",
          value: "secret-password",
        },
        {
          element_index: 1,
          role: "AXTextField",
          label: "Password",
          value: "another-secret",
        },
        {
          element_index: 2,
          role: "AXButton",
          label: "Continue",
          actions: ["AXPress"],
        },
      ],
    },
    target,
  );
  assert.equal(result.elements.length, 1);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|password/i);
});

test("partial, missing-completeness and degraded observations cannot claim complete evidence", () => {
  for (const flags of [
    { truncated: true },
    { degraded: true },
    { elements_complete: undefined },
    { filtered_element_count: 1 },
    { filtered_element_count: 0 },
  ]) {
    assert.equal(
      normalizeObservation({ ...state(), ...flags }, target).complete,
      false,
    );
  }
  assert.equal(normalizeObservation(state(), target, true).complete, false);
  assert.equal(normalizeObservation(state(), target).complete, true);
  assert.throws(() =>
    normalizeObservation({ ...state(), filtered_element_count: -1 }, target),
  );
});

test("receipts require confirmed background evidence and preserve stale refusal without raw text", () => {
  for (const payload of [
    { effect: "unverifiable", delivery: { mode: "background" } },
    { effect: "confirmed", delivery: { mode: "background" } },
    {
      effect: "confirmed",
      delivery: { mode: "foreground" },
      evidence: [{ kind: "value_readback" }],
    },
    { executed: true },
  ])
    assert.equal(
      normalizeReceipt({ structuredContent: payload }).executed,
      false,
    );
  assert.deepEqual(
    normalizeReceipt({
      isError: true,
      structuredContent: {
        refusal: { code: "stale_element_token", message: "private content" },
      },
    }),
    { executed: false, stale: true, effect: "refused" },
  );
});

test("tool discovery handles pagination and rejects repeated cursors", async () => {
  const fixture = fake();
  let page = 0;
  fixture.client.listTools = async (input) => {
    assert.equal(input?.cursor, page === 0 ? undefined : "next");
    page += 1;
    return page === 1
      ? { tools: tools().slice(0, 2), nextCursor: "next" }
      : { tools: tools().slice(2) };
  };
  await createDriver(fixture.client, session);
  assert.equal(page, 2);
  fixture.client.listTools = async () => ({ tools: [], nextCursor: "loop" });
  await assert.rejects(
    createDriver(fixture.client, session),
    /did not terminate/,
  );
});

test("app discovery preserves running identity without returning implementation metadata", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      apps: [
        {
          pid: 42,
          name: "Calculator",
          bundle_id: "com.apple.calculator",
          running: true,
          active: false,
          launch_path: "/private/path",
        },
        {
          pid: 0,
          name: "Notes",
          bundle_id: "com.apple.Notes",
          running: false,
          active: false,
        },
      ],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.listApps!(), {
    apps: [
      {
        pid: 42,
        name: "Calculator",
        bundle_id: "com.apple.calculator",
        running: true,
        active: false,
      },
      {
        pid: 0,
        name: "Notes",
        bundle_id: "com.apple.Notes",
        running: false,
        active: false,
      },
    ],
  });
  assert.deepEqual(fixture.calls[0], { name: "list_apps", arguments: {} });
});

test("screenshot requests a precise capture-only window and returns only its image", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const fixture = fake(tools(), {
    structuredContent: { pid: 42, window_id: 12 },
    content: [
      { type: "text", text: "not returned" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.screenshot!(target), {
    data: png,
    mimeType: "image/png",
  });
  assert.deepEqual(fixture.calls[0], {
    name: "get_window_state",
    arguments: {
      pid: 42,
      window_id: 12,
      session,
      include_screenshot: true,
      include_accessibility_tree: false,
    },
  });
});

test("screenshot refuses different windows and invalid or ambiguous image payloads", async () => {
  for (const result of [
    { structuredContent: { pid: 42, window_id: 99 }, content: [] },
    { structuredContent: { pid: 42, window_id: 12 }, content: [] },
    {
      structuredContent: { pid: 42, window_id: 12 },
      content: [{ type: "image", data: "nope", mimeType: "image/png" }],
    },
    {
      structuredContent: { pid: 42, window_id: 12 },
      content: [{ type: "image" }, { type: "image" }],
    },
  ]) {
    const fixture = fake(tools(), result);
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(driver.screenshot!(target));
  }
});

test("set_value replaces through its exact semantic contract without typing or synthetic shortcuts", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      effect: "confirmed",
      route: "accessibility",
      delivery: { mode: "background" },
      evidence: [{ kind: "value_readback" }],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.equal(
    (
      await driver.execute({
        kind: "set_value",
        target,
        elementToken: "s00000001:1",
        value: "replacement",
      })
    ).executed,
    true,
  );
  assert.deepEqual(fixture.calls, [
    {
      name: "set_value",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        element_token: "s00000001:1",
        value: "replacement",
      },
    },
  ]);
});

test("set_value refuses absent snapshot-token support and never falls back to insertion", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "set_value"
      ? tool(
          "set_value",
          { session: str, pid: int, window_id: int, value: str },
          ["pid", "value"],
        )
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({
      kind: "set_value",
      target,
      elementToken: "s00000001:1",
      value: "replacement",
    }),
    /required safe input contract/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("set_value uses explicit background mode if the installed Driver advertises one", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "set_value"
      ? tool(
          "set_value",
          {
            ...common,
            target: { type: "object" },
            element_token: str,
            value: str,
          },
          ["target", "value"],
        )
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await driver.execute({
    kind: "set_value",
    target,
    elementToken: "s00000001:1",
    value: "replacement",
  });
  assert.deepEqual(fixture.calls[0]?.arguments, {
    target: { kind: "window", pid: 42, window_id: 12 },
    session,
    delivery_mode: "background",
    element_token: "s00000001:1",
    value: "replacement",
  });
});

test("macOS pending permissions reports the exact setup blocker without echoing native details", async () => {
  const fixture = fake(tools(), {
    isError: true,
    structuredContent: { code: "tool_invocation_failed", exit_code: 75 },
    content: [
      {
        type: "text",
        text: "permissions_pending: macOS Accessibility or Screen Recording permission is still pending; private native detail",
      },
    ],
  });
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(driver.listApps!(), {
    message:
      "Cua Driver is waiting for macOS Accessibility or Screen Recording permission. Complete the system permission prompts, then retry.",
  });
  assert.equal(fixture.calls.length, 1);
});

test("CUA integer formats validate without ignored-format warnings and retain standard formats", () => {
  const validator = createDriverSchemaValidator();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const validate = validator.getValidator({
      type: "object",
      properties: {
        pid: { type: "integer", format: "uint32" },
        window: { type: "integer", format: "uint64" },
        uri: { type: "string", format: "uri" },
      },
      required: ["pid", "window", "uri"],
    });
    assert.equal(
      validate({ pid: 42, window: 12, uri: "https://example.com" }).valid,
      true,
    );
    assert.equal(
      validate({ pid: 4_294_967_296, window: 12, uri: "https://example.com" })
        .valid,
      false,
    );
    assert.equal(
      validate({
        pid: 42,
        window: Number.MAX_SAFE_INTEGER + 1,
        uri: "https://example.com",
      }).valid,
      false,
    );
    assert.equal(
      validate({ pid: 42, window: 12, uri: "not a uri" }).valid,
      false,
    );
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});
