import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const runFile = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_NAME = "Jev Bot Fixture";
const BUNDLE_ID = "com.jev-bot.fixture";

class SmokeFailure extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SmokeFailure("Expected a JSON object.");
  return value as Record<string, unknown>;
}

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")));
}

async function waitForFile(
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    signal.throwIfAborted();
    try {
      return await jsonFile(path);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    await pause(100, undefined, { signal });
  }
  throw new SmokeFailure(
    "The owned fixture did not write its expected file before the deadline.",
  );
}

function marker(
  result: CallToolResult,
  expectedStep: string,
): Record<string, unknown> {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    try {
      const value = object(JSON.parse(block.text));
      if (value.smokeStep === expectedStep) return value;
    } catch {
      // Documentation and fixture AX text are ordinary MCP text blocks.
    }
  }
  throw new SmokeFailure(
    `The ${expectedStep} call did not return its expected checkpoint.`,
  );
}

async function stopOwnedChild(child?: ChildProcess): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await Promise.race([exited, pause(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, pause(1_000)]);
  }
}

/** Explicit live check. It makes two paid Jev requests and never retries input. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.includes("--live")) {
    console.log(
      "Skipped: pass --live to compile and launch the owned native fixture and make two Jev requests.",
    );
    return;
  }
  if (args.some((argument) => argument !== "--live"))
    throw new SmokeFailure("Only --live is supported.");
  if (process.platform !== "darwin")
    throw new SmokeFailure("Skipped: this native smoke check requires macOS.");
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (!process.env.TYPESAFE_API_KEY?.trim())
    throw new SmokeFailure(
      "Skipped: TYPESAFE_API_KEY is missing. No app was launched.",
    );

  const controller = new AbortController();
  // Reserve up to five seconds for cleanup inside an 80-second overall budget.
  const timer = setTimeout(
    () => controller.abort(new Error("Live smoke work deadline reached.")),
    75_000,
  );
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(root, ".local", "native-smoke", runId);
  const receiptPath = join(runDirectory, "receipt.json");
  const readyPath = join(runDirectory, "ready.json");
  const token = `jev-bot-${randomUUID()}`;
  const title = `${APP_NAME} ${runId.slice(-8)}`;
  const results: Record<string, unknown> = {
    runId,
    startedAt,
    outcome: "failed",
    stages: [],
  };
  const stages: Record<string, unknown>[] = [];
  results.stages = stages;
  let artifactReady = false;
  let stage = "permission preflight";
  let fixture: ChildProcess | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    const driverBinary =
      process.env.CUA_DRIVER_BIN ??
      "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
    await access(driverBinary, constants.X_OK);
    const permissionOutput = await runFile(
      driverBinary,
      ["permissions", "status", "--json"],
      {
        timeout: 10_000,
        signal: controller.signal,
        maxBuffer: 256_000,
        env: getDefaultEnvironment(),
      },
    );
    const permissions = object(JSON.parse(permissionOutput.stdout));
    const source =
      permissions.source && typeof permissions.source === "object"
        ? object(permissions.source)
        : {};
    if (
      source.attribution !== "driver-daemon" ||
      permissions.accessibility !== true ||
      permissions.screen_recording !== true
    ) {
      throw new SmokeFailure(
        "Skipped: Cua Driver permissions are not confirmed under driver-daemon identity. Grant and verify Accessibility and Screen Recording first. No app was launched.",
      );
    }
    results.permissions = {
      attribution: "driver-daemon",
      accessibility: true,
      screenRecording: true,
    };
    await access(join(root, "dist", "cli.js"));
    await mkdir(runDirectory, { recursive: true });
    artifactReady = true;

    stage = "compile fixture";
    const bundle = join(runDirectory, `${APP_NAME}.app`);
    const macos = join(bundle, "Contents", "MacOS");
    const binary = join(macos, "JevBotFixture");
    await mkdir(macos, { recursive: true });
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
<key>CFBundleExecutable</key><string>JevBotFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
    );
    await runFile(
      "/usr/bin/xcrun",
      [
        "swiftc",
        join(root, "test", "fixtures", "MacFixture.swift"),
        "-o",
        binary,
        "-framework",
        "Cocoa",
      ],
      {
        timeout: 30_000,
        signal: controller.signal,
        maxBuffer: 1_000_000,
        env: getDefaultEnvironment(),
      },
    );

    stage = "launch fixture";
    // Launch the exact app-bundle binary directly so its ChildProcess is owned.
    // The fixture gets neither the expected token nor model credentials.
    fixture = spawn(binary, [receiptPath, readyPath, title], {
      stdio: "ignore",
      env: getDefaultEnvironment(),
    });
    let spawnFailure = false;
    fixture.on("error", () => {
      spawnFailure = true;
    });
    const ready = await waitForFile(readyPath, 10_000, controller.signal);
    if (
      spawnFailure ||
      !fixture.pid ||
      ready.ready !== true ||
      ready.pid !== fixture.pid ||
      ready.windowTitle !== title
    ) {
      throw new SmokeFailure(
        "The ready file did not identify the owned fixture process.",
      );
    }
    results.fixturePid = fixture.pid;

    stage = "connect MCP";
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (typeof value === "string") environment[key] = value;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "cli.js"), "stdio"],
      cwd: root,
      env: environment,
      stderr: "pipe",
    });
    // Drain provider/native diagnostics without writing credentials or unrelated
    // app metadata into the smoke artifact.
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "jev-bot-native-smoke", version: "0.1.0" });
    await client.connect(transport, {
      timeout: 10_000,
      signal: controller.signal,
    });

    const call = async (
      name: string,
      code: string,
    ): Promise<Record<string, unknown>> => {
      stage = name;
      const began = performance.now();
      const response = CallToolResultSchema.parse(
        await client!.callTool(
          {
            name: "js",
            arguments: {
              code,
              title: `Native fixture: ${name}`,
              timeout_ms: 30_000,
            },
          },
          CallToolResultSchema,
          { timeout: 30_000, signal: controller.signal },
        ),
      );
      if (response.isError)
        throw new SmokeFailure(
          `The ${name} MCP call failed. No input was retried.`,
        );
      const checkpoint = marker(response, name);
      stages.push({
        step: name,
        elapsedMs: Math.round(performance.now() - began),
        status: checkpoint.status ?? "observed",
      });
      return checkpoint;
    };

    await call(
      "select_fixture",
      `
let inventory = await cua.getState({emit:false});
let fixtureWindows = inventory.windows.filter(window => window.pid === ${fixture.pid} && window.is_on_screen === true);
if (fixtureWindows.length !== 1) throw new Error("Owned fixture must have exactly one visible window.");
let fixtureApp = await cua.getWindow(${fixture.pid}, fixtureWindows[0].window_id);
await nodeRepl.write(JSON.stringify({smokeStep:"select_fixture",status:"observed"}));
`,
    );
    await call(
      "replace_value",
      `
let replacement = await fixtureApp.setValue("Verification value field", ${JSON.stringify(token)});
let observedFields = replacement.observation?.elements.filter(element => element.role === "AXTextField" && element.label === "Verification value") ?? [];
if (observedFields.length !== 1 || observedFields[0].value !== ${JSON.stringify(token)}) throw new Error("Replacement was not observed; Submit will not be clicked.");
await nodeRepl.write(JSON.stringify({smokeStep:"replace_value",status:replacement.status}));
`,
    );
    await call(
      "click_submit",
      `
let submitted = await fixtureApp.click("Submit button");
await nodeRepl.write(JSON.stringify({smokeStep:"click_submit",status:submitted.status}));
`,
    );
    await call(
      "read_back",
      `
await fixtureApp.getAXState({emit:false,disableDiffing:true});
await nodeRepl.write(JSON.stringify({smokeStep:"read_back",status:"observed"}));
`,
    );

    stage = "independent receipt verification";
    const receipt = await waitForFile(receiptPath, 2_000, controller.signal);
    if (
      receipt.token !== token ||
      receipt.clickCount !== 1 ||
      receipt.pid !== fixture.pid
    ) {
      throw new SmokeFailure(
        "Independent fixture receipt failed: expected the exact token and exactly one Submit click from the owned process.",
      );
    }
    results.outcome = "passed";
    results.independentVerification = {
      exactToken: true,
      clickCount: 1,
      ownedProcess: true,
    };
    results.decisionCalls = 2;
    console.log(
      `Passed native fixture smoke. Two Jev decisions; independent exact-value and single-click receipt verified.\n${join(runDirectory, "result.json")}`,
    );
  } catch (error) {
    const reason =
      error instanceof SmokeFailure
        ? error.message
        : `${stage} failed or exceeded its deadline. No input was retried.`;
    results.failure = { stage, reason };
    throw new SmokeFailure(reason);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Client transport cleanup only owns its stdio server. It never stops a
    // shared Cua Driver daemon; fixture cleanup only signals its ChildProcess.
    await Promise.allSettled([
      client?.close() ?? transport?.close(),
      stopOwnedChild(fixture),
    ]);
    results.finishedAt = new Date().toISOString();
    if (artifactReady) {
      await writeFile(
        join(runDirectory, "result.json"),
        JSON.stringify(results, null, 2) + "\n",
      );
      await writeFile(
        join(root, ".local", "native-smoke", "latest.json"),
        JSON.stringify(
          {
            runId,
            outcome: results.outcome,
            resultPath: join(runDirectory, "result.json"),
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof SmokeFailure
        ? error.message
        : "Native smoke setup failed. No input was retried.",
    );
    process.exitCode = 1;
  });
}
