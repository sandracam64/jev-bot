#!/usr/bin/env node
/**
 * Start the local MCP server over standard input and output, or check the native
 * Cua Driver connection with `jev-bot doctor`.
 *
 * Run `jev-bot --help` for commands and environment-file options. This entrypoint
 * runs the CLI when imported; use the package root to create a session in code.
 *
 * @module
 */
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createSession, LazyDriver } from "./runtime.js";
import { parseCliArguments } from "./cli-options.js";

const { command, envFile } = parseCliArguments(process.argv.slice(2));
if (command === "--help" || command === "-h") {
  console.log(
    "Usage: jev-bot [stdio|doctor] [--env-file /absolute/path/.env]\nStarts a local MCP server by default. Cua Driver controls native apps; Jev actions also require TYPESAFE_API_KEY.",
  );
} else {
  try {
    process.loadEnvFile(
      envFile
        ? resolve(envFile)
        : fileURLToPath(new URL("../.env", import.meta.url)),
    );
  } catch (error) {
    if (
      envFile ||
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      throw new Error(
        "Unable to load the environment file. Check its path and permissions.",
      );
  }
  if (command === "doctor") {
    const driver = new LazyDriver();
    try {
      const windows = await driver.listWindows();
      console.log(
        JSON.stringify(
          {
            driver: "connected",
            typesafeKeyConfigured: Boolean(process.env.TYPESAFE_API_KEY),
            windows,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Driver check failed.",
      );
      console.error(
        "Inspect setup with /Applications/CuaDriver.app/Contents/MacOS/cua-driver doctor.",
      );
      process.exitCode = 1;
    } finally {
      await driver.close();
    }
  } else {
    const runtime = createSession();
    const server = createServer(runtime);
    let closing = false;
    async function shutdown() {
      if (closing) return;
      closing = true;
      try {
        await runtime.close();
      } finally {
        await server.close();
      }
    }
    const teardown = () => {
      void shutdown().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", teardown);
    process.once("SIGTERM", teardown);
    const transport = new StdioServerTransport();
    server.server.onclose = teardown;
    await server.connect(transport);
  }
}
