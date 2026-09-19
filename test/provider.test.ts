import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { createChooser } from "../src/provider.js";
import type { Observation } from "../src/types.js";

const observation: Observation = {
  target: { pid: 10, windowId: 20 },
  snapshotId: "s1",
  appName: "Fixture",
  windowTitle: "Test",
  complete: true,
  degraded: false,
  elements: [
    {
      index: 1,
      token: "s1:1",
      role: "AXTextField",
      secure: true,
      value: "secret-fixture",
      actions: [],
    },
  ],
};
const candidates = [
  { id: "handoff", description: "Ask the caller" },
  { id: "done", description: "Finished" },
];

void test("official SDK sends one bounded Choice and redacts secure values", async () => {
  const requestSchema = z
    .object({
      questions: z.object({
        next_action: z.object({ criteria: z.record(z.string()) }),
      }),
    })
    .passthrough();
  const requests: z.infer<typeof requestSchema>[] = [];
  const client = new TypeSafeClient({
    apiKey: "fixture-key",
    fetch: async (_url, init) => {
      assert.ok(typeof init?.body === "string");
      requests.push(requestSchema.parse(JSON.parse(init.body)));
      return Response.json({
        model: "fixture",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          next_action: {
            type: "choice",
            choice: "handoff",
            confidence: 0.9,
            probabilities: { handoff: 0.95, done: 0.05 },
          },
        },
      });
    },
  });
  const result = await createChooser(client)(
    "Do the task",
    observation,
    candidates,
    [],
  );
  assert.equal(result.selectedId, "handoff");
  assert.equal(requests.length, 1);
  assert.ok(requests[0]);
  assert.deepEqual(Object.keys(requests[0].questions.next_action.criteria), [
    "handoff",
    "done",
  ]);
  assert.ok(!JSON.stringify(requests).includes("secret-fixture"));
  assert.ok(!JSON.stringify(requests).includes("s1:1"));
});

void test("malformed model choices never escape the provider", async () => {
  for (const answer of [
    {
      choice: "invented",
      confidence: 1,
      probabilities: { handoff: 0.5, done: 0.5 },
    },
    { choice: "done", confidence: 1, probabilities: { done: 1 } },
    { choice: "done", confidence: 1, probabilities: { handoff: 1, done: 1 } },
    { choice: "done", confidence: 2, probabilities: { handoff: 0, done: 1 } },
  ]) {
    const client = new TypeSafeClient({
      apiKey: "fixture-key",
      fetch: async () =>
        Response.json({
          answers: { next_action: { type: "choice", ...answer } },
        }),
    });
    await assert.rejects(
      createChooser(client)("Task", observation, candidates, []),
    );
  }
});

void test("provider errors are not retried", async () => {
  let calls = 0;
  const client = new TypeSafeClient({
    apiKey: "fixture-key",
    fetch: async () => {
      calls += 1;
      return Response.json({ error: "fixture failure" }, { status: 503 });
    },
  });
  await assert.rejects(
    createChooser(client)("Task", observation, candidates, []),
  );
  assert.equal(calls, 1);
});

void test("cancelled inference performs no mutation or retry", async () => {
  const client = new TypeSafeClient({
    apiKey: "fixture-key",
    fetch: async () => {
      throw new Error("fetch must not run");
    },
  });
  await assert.rejects(
    createChooser(client)(
      "Task",
      observation,
      candidates,
      [],
      AbortSignal.abort(),
    ),
  );
});
