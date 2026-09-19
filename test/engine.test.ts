import assert from "node:assert/strict";
import test from "node:test";
import { DesktopEngine } from "../src/engine.js";
import type {
  Candidate,
  Choose,
  Decision,
  Driver,
  Element,
  JsonObject,
  NativeAction,
  Observation,
  RunRequest,
} from "../src/types.js";

const target = { pid: 42, windowId: 7 };
const button: Element = {
  index: 1,
  token: "token-1",
  role: "AXButton",
  label: "Save",
  enabled: true,
  actions: ["AXPress"],
};
const field: Element = {
  index: 2,
  token: "token-2",
  role: "AXTextField",
  label: "Name",
  value: "",
  enabled: true,
  actions: [],
};
const request: RunRequest = { goal: "Save the document", target };

function observation(
  elements: readonly Element[] = [button, field],
  extra: Partial<Observation> = {},
): Observation {
  return {
    target,
    snapshotId: "snapshot-1",
    appName: "Test app",
    windowTitle: "Document",
    complete: true,
    degraded: false,
    elements,
    ...extra,
  };
}

class FakeDriver implements Driver {
  reads = 0;
  lists = 0;
  closed = false;
  closeCalls = 0;
  executed: NativeAction[] = [];
  receipt: JsonObject = { executed: true };
  executeHook?: () => Promise<JsonObject>;
  observeHook?: () => Promise<Observation>;

  constructor(
    readonly observations: readonly (Observation | Error)[] = [observation()],
  ) {}

  async listWindows(): Promise<JsonObject> {
    this.lists++;
    return { windows: [target] };
  }

  async observe(): Promise<Observation> {
    this.reads++;
    if (this.observeHook) return this.observeHook();
    const result =
      this.observations[
        Math.min(this.reads - 1, this.observations.length - 1)
      ]!;
    if (result instanceof Error) throw result;
    return result;
  }

  async execute(action: NativeAction): Promise<JsonObject> {
    this.executed.push(action);
    return this.executeHook ? this.executeHook() : this.receipt;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls++;
  }
}

function answer(
  candidates: readonly Candidate[],
  selectedId = candidates[0]!.id,
): Decision {
  return {
    selectedId,
    confidence: 1,
    probabilities: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        Number(candidate.id === selectedId),
      ]),
    ),
  };
}

const chooseFirst: Choose = async (_goal, _observation, candidates) =>
  answer(candidates);

void test("matches a unique exact postcondition before any provider call or mutation", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(driver, async () => {
    throw new Error("must not call provider");
  });
  const result = await engine.run({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "" },
  });
  assert.equal(result.status, "verified");
  assert.equal(driver.executed.length, 0);
});

void test("empty and ambiguous completion conditions cannot report success", async () => {
  const driver = new FakeDriver([
    observation([button, { ...button, token: "other", index: 3 }]),
  ]);
  const engine = new DesktopEngine(driver, chooseFirst);
  await assert.rejects(engine.run({ ...request, expect: {} }), /exact/);
  await assert.rejects(
    engine.run({ ...request, expect: { valueEquals: "Save" } }),
    /selector/,
  );
  await assert.rejects(
    engine.run({ ...request, expect: { role: "AXButton" } }),
    /selector/,
  );
  const result = await engine.run({
    ...request,
    expect: { labelEquals: "Save" },
  });
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /multiple/);
  assert.equal(driver.executed.length, 0);
});

void test("model done always hands verification to the host without a matching condition", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(driver, async (_goal, _state, candidates) =>
    answer(candidates, "done"),
  );
  const result = await engine.run(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /model chose done/);
  assert.equal(driver.executed.length, 0);
});

void test("the last budget action gets a fresh observation and exact completion check", async () => {
  const final = observation([{ ...field, value: "Complete" }], {
    snapshotId: "snapshot-2",
  });
  const driver = new FakeDriver([observation(), final]);
  const engine = new DesktopEngine(driver, chooseFirst);
  const result = await engine.run({
    ...request,
    maxSteps: 1,
    expect: {
      role: "AXTextField",
      labelEquals: "Name",
      valueEquals: "Complete",
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(driver.reads, 2);
  assert.equal(driver.executed.length, 1);
  assert.equal(result.observation?.snapshotId, "snapshot-2");
  assert.equal(result.history[0]?.outcome, "executed");
});

void test("unknown execution is observed once and never retried", async (t) => {
  for (const failure of ["throw", "unknown", "stale"] as const) {
    await t.test(failure, async () => {
      const driver = new FakeDriver([
        observation(),
        observation([field], { snapshotId: "after-attempt" }),
      ]);
      if (failure === "throw")
        driver.executeHook = async () => {
          throw new Error("connection dropped");
        };
      else
        driver.receipt =
          failure === "stale" ? { stale: true } : { accepted: true };
      const engine = new DesktopEngine(driver, chooseFirst);
      const result = await engine.run(request);
      assert.equal(result.status, failure === "stale" ? "handoff" : "unknown");
      assert.equal(driver.executed.length, 1);
      assert.equal(driver.reads, 2);
      assert.equal(result.observation?.snapshotId, "after-attempt");
      assert.equal(result.history.length, 1);
    });
  }
});

void test("independent postcondition can resolve a lost execution response", async () => {
  const driver = new FakeDriver([
    observation(),
    observation([{ ...field, value: "Saved" }]),
  ]);
  driver.executeHook = async () => {
    throw new Error("response lost after input");
  };
  const result = await new DesktopEngine(driver, chooseFirst).run({
    ...request,
    expect: { labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.history[0]?.outcome, "unknown");
  assert.equal(driver.executed.length, 1);
});

void test("failed postobservation preserves the attempted action and stops", async () => {
  const driver = new FakeDriver([observation(), new Error("read failed")]);
  const result = await new DesktopEngine(driver, chooseFirst).run(request);
  assert.equal(result.status, "unknown");
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.outcome, "executed");
  assert.equal(driver.executed.length, 1);
  assert.equal(result.observation, undefined);
});

void test("unchanged semantic state stops before repeating a confirmed action", async () => {
  const driver = new FakeDriver([
    observation(),
    observation(
      [
        { ...button, token: "fresh-token" },
        { ...field, token: "fresh-field" },
      ],
      { snapshotId: "new-id" },
    ),
  ]);
  let decisions = 0;
  const engine = new DesktopEngine(driver, async (...args) => {
    decisions++;
    return chooseFirst(...args);
  });
  const result = await engine.run(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /no observed accessibility change/);
  assert.equal(decisions, 1);
  assert.equal(driver.executed.length, 1);
});

void test("reobservation consumes the budget and the final read can verify completion", async () => {
  const driver = new FakeDriver([
    observation(),
    observation(),
    observation([{ ...field, value: "Ready" }]),
  ]);
  const engine = new DesktopEngine(driver, async (_goal, _state, candidates) =>
    answer(candidates, "reobserve"),
  );
  const result = await engine.run({
    ...request,
    maxSteps: 2,
    expect: { labelEquals: "Name", valueEquals: "Ready" },
  });
  assert.equal(result.status, "verified");
  assert.equal(driver.reads, 3);
  assert.equal(result.history.length, 2);
  assert.equal(driver.executed.length, 0);
  const exhausted = await new DesktopEngine(
    new FakeDriver(),
    async (_goal, _state, candidates) => answer(candidates, "reobserve"),
  ).run({ ...request, maxSteps: 2 });
  assert.equal(exhausted.status, "budget_exhausted");
  assert.equal(exhausted.history.length, 2);
});

void test("only advertised enabled native actions and caller-supplied text become candidates", async () => {
  const elements: Element[] = [
    button,
    field,
    { ...button, token: "disabled", index: 3, enabled: false },
    { ...button, token: "web", index: 4, inWebContent: true },
    {
      ...field,
      token: "password",
      index: 5,
      label: "Password",
      value: "secret",
    },
    {
      ...field,
      token: "secure",
      index: 6,
      label: "Code",
      secure: true,
      value: "secret",
    },
    { ...button, token: "unknown", index: 7, actions: ["AXShowMenu"] },
    { ...field, token: "unadvertised", index: 8, role: "AXStaticText" },
    { ...button, token: "not-known-enabled", index: 9, enabled: undefined },
  ];
  const driver = new FakeDriver([observation(elements)]);
  const seen: Candidate[][] = [];
  const engine = new DesktopEngine(driver, async (_goal, state, candidates) => {
    seen.push([...candidates]);
    assert.equal(
      state.elements.find((element) => element.token === "password")?.value,
      undefined,
    );
    assert.equal(
      state.elements.find((element) => element.token === "secure")?.value,
      undefined,
    );
    return answer(candidates, "handoff");
  });
  await engine.run(request);
  await engine.run({ ...request, text: "Exact caller text" });
  assert.deepEqual(
    seen[0]!.flatMap((candidate) =>
      candidate.action ? [candidate.action.kind] : [],
    ),
    ["click"],
  );
  const actions = seen[1]!.flatMap((candidate) =>
    candidate.action ? [candidate.action] : [],
  );
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1], {
    kind: "type_text",
    target,
    elementToken: "token-2",
    text: "Exact caller text",
  });
});

void test("keys are scoped to the supplied allowlist and invalid strings fail before native calls", async () => {
  const driver = new FakeDriver();
  let offered: readonly Candidate[] = [];
  const engine = new DesktopEngine(
    driver,
    async (_goal, _state, candidates) => {
      offered = candidates;
      return answer(candidates, "handoff");
    },
  );
  await engine.run({ ...request, keys: ["return", "tab", "return"] });
  assert.deepEqual(
    offered.flatMap((candidate) =>
      candidate.action?.kind === "press_key" ? [candidate.action.key] : [],
    ),
    ["return", "tab"],
  );
  const readsBefore = driver.reads;
  await assert.rejects(
    engine.run({ ...request, keys: ["command+q"] }),
    /supported native keys/,
  );
  assert.equal(driver.reads, readsBefore);
});

void test("missing or repeated actionable tokens return to the host", async (t) => {
  for (const elements of [
    [{ ...button, token: undefined }],
    [button, { ...button, index: 2 }],
  ]) {
    await t.test(JSON.stringify(elements), async () => {
      let called = false;
      const driver = new FakeDriver([observation(elements)]);
      const result = await new DesktopEngine(driver, async (...args) => {
        called = true;
        return chooseFirst(...args);
      }).run(request);
      assert.equal(result.status, "handoff");
      assert.match(result.reason, /token/);
      assert.equal(called, false);
    });
  }
});

void test("candidate overflow hands off instead of truncating supported choices", async () => {
  const elements = Array.from({ length: 253 }, (_, index) => ({
    ...button,
    index,
    token: `token-${index}`,
  }));
  const driver = new FakeDriver([observation(elements)]);
  const result = await new DesktopEngine(driver, async () => {
    throw new Error("must not call provider");
  }).run(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /255/);
  assert.equal(driver.executed.length, 0);
  const bounded = new FakeDriver([observation(elements.slice(0, 252))]);
  await new DesktopEngine(bounded, async (_goal, _state, candidates) => {
    assert.equal(candidates.length, 255);
    return answer(candidates, "handoff");
  }).run(request);
});

void test("degraded or empty accessibility trees cannot verify or execute", async (t) => {
  for (const state of [
    observation([button], { degraded: true }),
    observation([]),
  ]) {
    await t.test(JSON.stringify(state), async () => {
      const driver = new FakeDriver([state]);
      const result = await new DesktopEngine(driver, async () => {
        throw new Error("must not call provider");
      }).run({ ...request, expect: { labelEquals: "Save" } });
      assert.equal(result.status, "handoff");
      assert.equal(driver.executed.length, 0);
    });
  }
});

void test("partial accessibility projections allow grounded actions and positive observed predicates", async () => {
  const driver = new FakeDriver([
    observation([button, field], { complete: false }),
    observation([{ ...field, value: "Saved" }], {
      complete: false,
      snapshotId: "after-save",
    }),
  ]);
  const result = await new DesktopEngine(driver, chooseFirst).run({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(driver.executed.length, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.observation?.complete, false);
  assert.match(result.reason, /within the returned window elements/);
});

void test("an absent predicate on a partial projection never counts as verification", async () => {
  const driver = new FakeDriver([observation([button], { complete: false })]);
  const result = await new DesktopEngine(
    driver,
    async (_goal, _state, candidates) => answer(candidates, "done"),
  ).run({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "handoff");
});

void test("different values cannot disambiguate two elements with the same completion selector", async () => {
  const driver = new FakeDriver([
    observation(
      [
        { ...field, value: "Saved" },
        { ...field, index: 3, token: "other-field", value: "Unsaved" },
      ],
      { complete: false },
    ),
  ]);
  const result = await new DesktopEngine(driver, chooseFirst).run({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /selector matches multiple/);
  assert.equal(driver.executed.length, 0);
});

void test("invalid decisions cannot reach native execution", async (t) => {
  const mutations: Record<string, (value: Decision) => Decision> = {
    "unknown choice": (value) => ({ ...value, selectedId: "invented" }),
    "NaN confidence": (value) => ({ ...value, confidence: NaN }),
    "infinite confidence": (value) => ({ ...value, confidence: Infinity }),
    "negative confidence": (value) => ({ ...value, confidence: -1 }),
    "low confidence": (value) => ({ ...value, confidence: 0.6 }),
    "high confidence": (value) => ({ ...value, confidence: 1.01 }),
    "NaN probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: NaN },
    }),
    "infinite probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: Infinity },
    }),
    "negative probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: -0.1 },
    }),
    "missing probability": (value) => ({ ...value, probabilities: {} }),
    "extra probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, invented: 0 },
    }),
    "wrong sum": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: 0.5 },
    }),
    "not argmax": (value) => ({
      ...value,
      probabilities: {
        ...value.probabilities,
        [value.selectedId]: 0.2,
        handoff: 0.8,
      },
    }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const driver = new FakeDriver();
      const result = await new DesktopEngine(
        driver,
        async (_goal, _state, candidates) => mutate(answer(candidates)),
      ).run(request);
      assert.equal(result.status, "handoff");
      assert.equal(driver.executed.length, 0);
    });
  }
});

void test("snapshots, candidates, and provider history are immutable owned copies", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(
    driver,
    async (_goal, state, candidates, history) => {
      assert.ok(Object.isFrozen(state));
      assert.ok(Object.isFrozen(state.elements[0]));
      assert.ok(Object.isFrozen(candidates));
      assert.ok(Object.isFrozen(candidates[0]?.action));
      assert.ok(Object.isFrozen(history));
      assert.notEqual(state, driver.observations[0]);
      return answer(candidates, "handoff");
    },
  );
  const result = await engine.run(request);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.history));
});

void test("cancellation before execution does not mutate", async (t) => {
  await t.test("already cancelled", async () => {
    const driver = new FakeDriver();
    const signal = AbortSignal.abort();
    const result = await new DesktopEngine(driver, chooseFirst).run(
      request,
      signal,
    );
    assert.equal(result.status, "cancelled");
    assert.equal(driver.reads, 0);
    assert.equal(driver.executed.length, 0);
  });
  await t.test("cancelled during decision", async () => {
    const controller = new AbortController();
    const driver = new FakeDriver();
    const result = await new DesktopEngine(
      driver,
      async (_goal, _state, candidates) => {
        controller.abort();
        return answer(candidates);
      },
    ).run(request, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(driver.executed.length, 0);
  });
});

void test("cancellation during native input is unknown and gets a fresh read without retry", async () => {
  const controller = new AbortController();
  const driver = new FakeDriver([
    observation(),
    observation([{ ...field, value: "Ready" }]),
  ]);
  driver.executeHook = async () => {
    controller.abort();
    return { executed: true };
  };
  const result = await new DesktopEngine(driver, chooseFirst).run(
    { ...request, expect: { labelEquals: "Name", valueEquals: "Ready" } },
    controller.signal,
  );
  assert.equal(result.status, "unknown");
  assert.equal(driver.executed.length, 1);
  assert.equal(driver.reads, 2);
});

void test("a pending run denies overlapping runs, observations, window lists, and close", async () => {
  let release!: (decision: Decision) => void;
  let entered!: () => void;
  let choices!: readonly Candidate[];
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const driver = new FakeDriver();
  const engine = new DesktopEngine(
    driver,
    async (_goal, _state, candidates) => {
      choices = candidates;
      entered();
      return new Promise<Decision>((resolve) => {
        release = resolve;
      });
    },
  );
  const pending = engine.run(request);
  await ready;
  await assert.rejects(engine.run(request), /busy/);
  await assert.rejects(engine.observe(target), /busy/);
  await assert.rejects(engine.listWindows(), /busy/);
  await assert.rejects(engine.listApps(), /busy/);
  await assert.rejects(engine.screenshot(target), /busy/);
  await assert.rejects(
    engine.execute({ kind: "click", target, elementToken: "token-1" }),
    /busy/,
  );
  await assert.rejects(engine.close(), /busy/);
  assert.equal(driver.reads, 1);
  assert.equal(driver.lists, 0);
  release(answer(choices, "handoff"));
  await pending;
  await engine.listWindows();
  assert.equal(driver.lists, 1);
  await engine.close();
  assert.equal(driver.closed, true);
  await assert.rejects(engine.observe(target), /closed/);
});

void test("a pending standalone observation also owns the native session", async () => {
  let release!: (state: Observation) => void;
  const driver = new FakeDriver();
  driver.observeHook = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const engine = new DesktopEngine(driver, chooseFirst);
  const pending = engine.observe(target);
  await assert.rejects(engine.run(request), /busy/);
  await assert.rejects(engine.listWindows(), /busy/);
  release(observation());
  await pending;
});

void test("invalid bounds and wrong-window observations never execute", async () => {
  const driver = new FakeDriver([
    observation([], { target: { pid: 42, windowId: 8 } }),
  ]);
  const engine = new DesktopEngine(driver, chooseFirst);
  for (const maxSteps of [0, 9, 1.5, NaN])
    await assert.rejects(engine.run({ ...request, maxSteps }), /maxSteps/);
  const result = await engine.run(request);
  assert.equal(result.status, "unknown");
  assert.equal(driver.executed.length, 0);
});

void test("semantic operations restrict the model to the requested action kinds", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(
    driver,
    async (_goal, _state, candidates) => {
      assert.deepEqual(
        candidates.flatMap((candidate) =>
          candidate.action ? [candidate.action.kind] : [],
        ),
        ["type_text"],
      );
      return answer(candidates, "handoff");
    },
  );
  await engine.run({
    ...request,
    text: "Hello",
    keys: ["return"],
    allowedKinds: ["type_text"],
  });
  const result = await engine.run({ ...request, allowedKinds: [] });
  assert.equal(result.status, "handoff");
  assert.equal(driver.executed.length, 0);
});

void test("semantic replacement uses set_value and never substitutes insertion", async () => {
  const driver = new FakeDriver([
    observation([{ ...field, value: "Existing text" }]),
    observation([{ ...field, value: "Replacement" }], {
      snapshotId: "after-replacement",
    }),
  ]);
  const engine = new DesktopEngine(
    driver,
    async (_goal, _state, candidates) => {
      const actions = candidates.flatMap((candidate) =>
        candidate.action ? [candidate] : [],
      );
      assert.equal(actions.length, 1);
      assert.deepEqual(actions[0]?.action, {
        kind: "set_value",
        target,
        elementToken: field.token,
        value: "Replacement",
      });
      assert.match(actions[0]!.description, /Replace the entire value/);
      return answer(candidates, actions[0]!.id);
    },
  );
  const result = await engine.run({
    ...request,
    text: "Replacement",
    allowedKinds: ["set_value"],
    expect: {
      role: "AXTextField",
      labelEquals: "Name",
      valueEquals: "Replacement",
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(driver.executed[0]?.kind, "set_value");
});

void test("general text runs describe insertion and offer no implicit replacement", async () => {
  const driver = new FakeDriver();
  await new DesktopEngine(driver, async (_goal, _state, candidates) => {
    const insertion = candidates.find(
      (candidate) => candidate.action?.kind === "type_text",
    );
    assert.match(
      insertion!.description,
      /Insert .* at the current caret or selection/,
    );
    assert.equal(
      candidates.some((candidate) => candidate.action?.kind === "set_value"),
      false,
    );
    return answer(candidates, "handoff");
  }).run({ ...request, text: "Additional text" });
});

void test("direct native execution is single-use and preserves uncertain delivery", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(driver, chooseFirst);
  const action: NativeAction = {
    kind: "click",
    target,
    elementToken: "token-1",
  };
  assert.deepEqual(await engine.execute(action), { executed: true });
  driver.executeHook = async () => {
    throw new Error("transport dropped");
  };
  const unknown = await engine.execute(action);
  assert.equal(unknown.executed, false);
  assert.equal(unknown.outcome, "unknown");
  assert.equal(driver.executed.length, 2);
  await assert.rejects(
    engine.execute({ kind: "press_key", target, key: "command+q" }),
    /unsupported/,
  );
  await assert.rejects(
    engine.execute({ kind: "click", target, elementToken: "" }),
    /token/,
  );
  assert.equal(driver.executed.length, 2);
});

void test("direct replacement accepts empty strings without rewriting insertion semantics", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(driver, chooseFirst);
  await engine.execute({
    kind: "set_value",
    target,
    elementToken: "token-2",
    value: "",
  });
  await engine.execute({
    kind: "type_text",
    target,
    elementToken: "token-2",
    text: "New text",
  });
  assert.deepEqual(driver.executed, [
    { kind: "set_value", target, elementToken: "token-2", value: "" },
    { kind: "type_text", target, elementToken: "token-2", text: "New text" },
  ]);
  await assert.rejects(
    engine.execute({
      kind: "set_value",
      target,
      elementToken: "token-2",
      value: "x".repeat(8_001),
    }),
    /value/,
  );
  assert.equal(driver.executed.length, 2);
});

void test("optional app and screenshot methods explain unavailable capabilities", async () => {
  const driver = new FakeDriver();
  const engine = new DesktopEngine(driver, chooseFirst);
  await assert.rejects(engine.listApps(), /does not support listing apps/);
  await assert.rejects(
    engine.screenshot(target),
    /does not support screenshots/,
  );
  const capable: Driver = {
    listApps: async () => ({ apps: ["Test app"] }),
    listWindows: () => driver.listWindows(),
    observe: () => driver.observe(),
    screenshot: async () => ({ data: "image-data", mimeType: "image/png" }),
    execute: (action) => driver.execute(action),
    close: () => driver.close(),
  };
  const supported = new DesktopEngine(capable, chooseFirst);
  assert.deepEqual(await supported.listApps(), { apps: ["Test app"] });
  assert.deepEqual(await supported.screenshot(target), {
    data: "image-data",
    mimeType: "image/png",
  });
});

void test("shutdown stops new calls, waits for pending native input, and closes once", async () => {
  let release!: (receipt: JsonObject) => void;
  const driver = new FakeDriver();
  driver.executeHook = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const engine = new DesktopEngine(driver, chooseFirst);
  const input = engine.execute({
    kind: "click",
    target,
    elementToken: "token-1",
  });
  const shutdown = engine.shutdown();
  assert.equal(engine.shutdown(), shutdown);
  await assert.rejects(engine.observe(target), /shutting down/);
  await assert.rejects(engine.listWindows(), /shutting down/);
  await assert.rejects(engine.run(request), /shutting down/);
  assert.equal(driver.closeCalls, 0);
  assert.equal(driver.closed, false);
  release({ executed: true });
  assert.deepEqual(await input, { executed: true });
  await shutdown;
  assert.equal(driver.closeCalls, 1);
  assert.equal(driver.closed, true);
  await engine.shutdown();
  await engine.close();
  assert.equal(driver.closeCalls, 1);
  await assert.rejects(engine.observe(target), /closed/);
});

void test("shutdown drains a failed operation without inheriting its rejection", async () => {
  let fail!: (error: Error) => void;
  const driver = new FakeDriver();
  driver.observeHook = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  const engine = new DesktopEngine(driver, chooseFirst);
  const failedRead = assert.rejects(engine.observe(target), /read interrupted/);
  const shutdown = engine.shutdown();
  assert.equal(driver.closeCalls, 0);
  fail(new Error("read interrupted"));
  await failedRead;
  await shutdown;
  assert.equal(driver.closeCalls, 1);
});

void test("shutdown and close share a single failed driver close without retrying", async () => {
  const driver = new FakeDriver();
  driver.close = async () => {
    driver.closeCalls++;
    throw new Error("close failed");
  };
  const engine = new DesktopEngine(driver, chooseFirst);
  await assert.rejects(engine.close(), /close failed/);
  await assert.rejects(engine.shutdown(), /close failed/);
  await assert.rejects(engine.shutdown(), /close failed/);
  assert.equal(driver.closeCalls, 1);
});
