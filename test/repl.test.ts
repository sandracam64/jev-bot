import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ComputerRepl, DOCUMENTATION } from "../dist/repl.js";
import type {
  Element,
  NativeAction,
  RunRequest,
  Target,
} from "../src/types.js";

type EnginePort = ConstructorParameters<typeof ComputerRepl>[0];
const target: Target = { pid: 123, windowId: 456 };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh/8AAAAASUVORK5CYII=";

function text(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function fixture(t: TestContext, overrides: Partial<EnginePort> = {}) {
  let sequence = 0;
  let elements: readonly Element[] = [
    {
      index: 1,
      role: "AXTextField",
      label: "Name",
      value: "",
      enabled: true,
      actions: ["AXPress"],
    },
    {
      index: 2,
      role: "AXButton",
      label: "Save",
      enabled: true,
      actions: ["AXPress"],
    },
  ];
  const actions: NativeAction[] = [];
  const observations: Array<{ target: Target; query?: string }> = [];
  const runs: Array<{ request: RunRequest; signal?: AbortSignal }> = [];
  const engine: EnginePort = {
    listApps: async () => ({
      apps: [
        {
          pid: 123,
          name: "Test Editor",
          bundle_id: "dev.test.editor",
          running: true,
        },
      ],
    }),
    listWindows: async () => ({
      windows: [
        { pid: 123, window_id: 456, title: "Document", is_on_screen: true },
      ],
    }),
    observe: async (selected, query) => {
      observations.push({ target: selected, query });
      const snapshotId = `snapshot-${++sequence}`;
      return {
        target: selected,
        snapshotId,
        appName: "Test Editor",
        windowTitle: "Document",
        elements: elements.map((element) => ({
          ...element,
          token: `${snapshotId}:${element.index}`,
        })),
        complete: true,
        degraded: false,
      };
    },
    screenshot: async () => ({ data: png, mimeType: "image/png" }),
    execute: async (action) => {
      actions.push(action);
      return { executed: true };
    },
    run: async (request, signal) => {
      runs.push({ request, signal });
      return {
        status: "handoff",
        reason: "Host should inspect the observation.",
        history: [],
      };
    },
    ...overrides,
  };
  const repl = new ComputerRepl(engine);
  t.after(() => repl.reset());
  return {
    repl,
    actions,
    observations,
    runs,
    setElements(this: void, value: readonly Element[]) {
      elements = value;
    },
  };
}

void test(
  "persistent bindings support top-level await and documentation is emitted once",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t);
    const first = await repl.execute(
      "let count = await Promise.resolve(3); await nodeRepl.write(count);",
      undefined,
      1_000,
    );
    assert.notEqual(first.isError, true, text(first));
    assert.ok(text(first).includes(DOCUMENTATION));
    assert.match(text(first), /\n3$/);
    const second = await repl.execute(
      "count += 4; await nodeRepl.write(count);",
      undefined,
      1_000,
    );
    assert.notEqual(second.isError, true, text(second));
    assert.equal(text(second), "7");
  },
);

void test(
  "getApp emits initial state and later observations report diffs or full state",
  { timeout: 5_000 },
  async (t) => {
    const { repl, observations, setElements } = fixture(t);
    const first = await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    assert.notEqual(first.isError, true, text(first));
    assert.match(
      text(first),
      /Test Editor: Document\n\[1\] AXTextField "Name"/,
    );
    assert.deepEqual(observations, [{ target, query: undefined }]);
    const unchanged = await repl.execute(
      "await app.getAXState();",
      undefined,
      1_000,
    );
    assert.match(text(unchanged), /No accessibility changes/);
    setElements([
      {
        index: 1,
        role: "AXTextField",
        label: "Name",
        value: "Sam",
        enabled: true,
        actions: ["AXPress"],
      },
    ]);
    const changed = await repl.execute(
      'await app.getAXState({query:"Name"});',
      undefined,
      1_000,
    );
    assert.match(text(changed), /- \[2\]/);
    assert.match(text(changed), /\+ \[1\].*value="Sam"/);
    assert.equal(observations.at(-1)?.query, "Name");
    const full = await repl.execute(
      "await app.getAXState({disableDiffing:true});",
      undefined,
      1_000,
    );
    assert.match(text(full), /\n\[1\]/);
    assert.doesNotMatch(text(full), /\n\+ /);
  },
);

void test(
  "direct mutations invalidate element indices until a fresh observation",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const pressed = await repl.execute("await app.click(2);", undefined, 1_000);
    assert.notEqual(pressed.isError, true, text(pressed));
    assert.equal(actions.length, 1);
    const stale = await repl.execute("await app.click(2);", undefined, 500);
    assert.equal(stale.isError, true);
    assert.match(text(stale), /Read fresh getAXState/);
    assert.doesNotMatch(text(stale), /timed out/);
    assert.equal(actions.length, 1);
    const refreshed = await repl.execute(
      "await app.getAXState(); await app.click(2);",
      undefined,
      1_000,
    );
    assert.notEqual(refreshed.isError, true, text(refreshed));
    assert.equal(actions.length, 2);
    assert.notDeepEqual(actions[0], actions[1]);
  },
);

void test(
  "screenshots emit image content and invalidate indices; combined state refreshes them",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const screenshot = await repl.execute(
      "let shot = await app.getScreenshot();",
      undefined,
      1_000,
    );
    assert.notEqual(screenshot.isError, true, text(screenshot));
    assert.deepEqual(screenshot.content, [
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    const stale = await repl.execute("await app.click(2);", undefined, 500);
    assert.equal(stale.isError, true);
    assert.match(text(stale), /Read fresh getAXState/);
    assert.equal(actions.length, 0);
    const both = await repl.execute(
      "await app.getAXStateAndScreenshot(); await app.click(2);",
      undefined,
      1_000,
    );
    assert.notEqual(both.isError, true, text(both));
    assert.equal(
      both.content.some((block) => block.type === "image"),
      true,
    );
    assert.match(text(both), /\[2\] AXButton "Save"/);
    assert.equal(actions.length, 1);
  },
);

void test(
  "app.act and semantic setters pass exact supplied text to the Jev engine",
  { timeout: 5_000 },
  async (t) => {
    const { repl, runs, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const exactText = "  Sam\n";
    const goal = "Fill the name field";
    const options = {
      text: exactText,
      keys: ["tab"],
      expect: { labelEquals: "Name", valueEquals: exactText },
      maxSteps: 2,
    };
    const result = await repl.execute(
      `await app.act(${JSON.stringify(goal)}, ${JSON.stringify(options)});`,
      undefined,
      1_000,
    );
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /"status":"handoff"/);
    assert.deepEqual(runs[0]?.request, { ...options, target, goal });
    assert.ok(runs[0]?.signal instanceof AbortSignal);
    await repl.execute(
      `await app.setValue("Name field", ${JSON.stringify(exactText)});`,
      undefined,
      1_000,
    );
    assert.deepEqual(runs[1]?.request, {
      target,
      goal: "Replace the value of the field described as Name field with the supplied exact text.",
      maxSteps: 1,
      allowedKinds: ["set_value"],
      text: exactText,
    });
    assert.equal(actions.length, 0);
  },
);

void test(
  "reset discards bindings and emits guidance on the next call",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor"); let previous = 9;',
      undefined,
      1_000,
    );
    await repl.reset();
    const next = await repl.execute(
      "await nodeRepl.write([typeof app, typeof previous]);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.ok(text(next).includes(DOCUMENTATION));
    assert.match(text(next), /\[ 'undefined', 'undefined' \]/);
  },
);

void test(
  "an infinite loop times out, cannot execute a later action, and loses its bindings",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const result = await repl.execute(
      'while (true) {} await app.pressKey("return");',
      undefined,
      100,
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out.*bindings were reset/s);
    const next = await repl.execute(
      "await nodeRepl.write(typeof app);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.match(text(next), /\nundefined$/);
    assert.equal(actions.length, 0);
  },
);

void test(
  "a rejected API promise returns an error promptly and leaves the REPL usable",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t, {
      listApps: async () => {
        throw new Error("Native listing failed.");
      },
    });
    await repl.execute("let preserved = 27;", undefined, 1_000);
    const failed = await repl.execute("await cua.listApps();", undefined, 500);
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Native listing failed/);
    assert.doesNotMatch(text(failed), /timed out/);
    const next = await repl.execute(
      "await nodeRepl.write(preserved);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "27");
  },
);

void test(
  "cancellation reaches an in-flight Jev run and clears the worker bindings",
  { timeout: 5_000 },
  async (t) => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let engineSignal: AbortSignal | undefined;
    const { repl, actions } = fixture(t, {
      run: async (_request, signal) => {
        engineSignal = signal;
        const cancelled = new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        markStarted();
        await cancelled;
        return {
          status: "cancelled",
          reason: "Caller cancelled.",
          history: [],
        };
      },
    });
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const controller = new AbortController();
    const pending = repl.execute(
      'await app.act("Open preferences"); await app.pressKey("return");',
      controller.signal,
      2_000,
    );
    await started;
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(text(result), /cancelled.*bindings were reset/s);
    assert.equal(engineSignal?.aborted, true);
    const next = await repl.execute(
      "await nodeRepl.write(typeof app);",
      undefined,
      1_000,
    );
    assert.match(text(next), /\nundefined$/);
    assert.equal(actions.length, 0);
  },
);

void test(
  "a delayed unawaited continuation cannot act during a later evaluation",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const setup = await repl.execute(
      `
    let releaseOld;
    let oldRejected = false;
    let gate = new Promise(resolve => { releaseOld = resolve; });
    void gate.then(() => app.pressKey("return")).catch(() => { oldRejected = true; });
  `,
      undefined,
      1_000,
    );
    assert.notEqual(setup.isError, true, text(setup));
    const next = await repl.execute(
      'releaseOld(); await nodeRepl.write("current evaluation");',
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "current evaluation");
    const checked = await repl.execute(
      "await nodeRepl.write(oldRejected);",
      undefined,
      1_000,
    );
    assert.equal(text(checked), "true");
    assert.equal(actions.length, 0);
  },
);

for (const interruption of ["cancel", "timeout"] as const) {
  void test(
    `typeText cannot act after ${interruption} during its fresh observation`,
    { timeout: 5_000 },
    async (t) => {
      let reads = 0;
      let markReadStarted: () => void = () => {};
      let releaseRead: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const delayedRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const { repl, actions } = fixture(t, {
        observe: async (selected) => {
          reads++;
          if (reads === 2) {
            markReadStarted();
            await delayedRead;
          }
          return {
            target: selected,
            snapshotId: `delayed-${reads}`,
            appName: "Test Editor",
            windowTitle: "Document",
            elements: [
              {
                index: 1,
                token: `field-${reads}`,
                role: "AXTextField",
                label: "Name",
                enabled: true,
                actions: ["AXPress"],
              },
            ],
            complete: true,
            degraded: false,
          };
        },
      });
      const setup = await repl.execute(
        'let app = await cua.getApp("Test Editor"); await app.setValue(1, "first");',
        undefined,
        1_000,
      );
      assert.notEqual(setup.isError, true, text(setup));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
      const controller = new AbortController();
      const pending = repl.execute(
        'await app.typeText("must not be typed");',
        controller.signal,
        interruption === "timeout" ? 75 : 1_000,
      );
      await readStarted;
      if (interruption === "cancel") controller.abort();
      const stopped = await pending;
      assert.equal(stopped.isError, true);
      assert.match(
        text(stopped),
        interruption === "cancel" ? /cancelled/ : /timed out/,
      );
      releaseRead();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
      const next = await repl.execute(
        'await nodeRepl.write("ready");',
        undefined,
        1_000,
      );
      assert.notEqual(next.isError, true, text(next));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
    },
  );
}

void test(
  "a semantic field selection clears the previous numeric text target",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions, runs } = fixture(t);
    const selected = await repl.execute(
      'let app = await cua.getApp("Test Editor"); await app.setValue(1, "field A");',
      undefined,
      1_000,
    );
    assert.notEqual(selected.isError, true, text(selected));
    assert.equal(actions.length, 1);
    const semantic = await repl.execute(
      'await app.setValue("Field B", "second field");',
      undefined,
      1_000,
    );
    assert.notEqual(semantic.isError, true, text(semantic));
    assert.equal(runs[0]?.request.text, "second field");
    const attempted = await repl.execute(
      'await app.typeText("must not reach field A");',
      undefined,
      1_000,
    );
    assert.equal(attempted.isError, true);
    assert.match(text(attempted), /Use setValue\(index, text\)/);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.kind, "set_value");
  },
);
