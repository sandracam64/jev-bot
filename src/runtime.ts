import { connectDriver } from "./driver.js";
import { DesktopEngine } from "./engine.js";
import { createChooser } from "./provider.js";
import { ComputerRepl } from "./repl.js";
import type { ReplRuntimePort } from "./server.js";
import type { Choose, Driver, NativeAction, Target } from "./types.js";

/** Optional adapters for embedding or testing a session. */
export interface SessionOptions {
  driver?: Driver;
  choose?: Choose;
}

/** A persistent JavaScript session that owns its native connection. */
export interface ComputerSession extends ReplRuntimePort {
  /** Cancel active JavaScript, drain native input, and close the connection. */
  close(): Promise<void>;
}

// Discovery of the MCP tools and ordinary JavaScript need no native connection.
export class LazyDriver implements Driver {
  private connection?: Promise<Driver>;
  private get(): Promise<Driver> {
    return (this.connection ??= connectDriver().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    }));
  }
  async listWindows() {
    return (await this.get()).listWindows();
  }
  async listApps() {
    const driver = await this.get();
    if (!driver.listApps)
      throw new Error("Driver does not expose app discovery.");
    return driver.listApps();
  }
  async observe(target: Target, query?: string) {
    return (await this.get()).observe(target, query);
  }
  async execute(action: NativeAction) {
    return (await this.get()).execute(action);
  }
  async screenshot(target: Target) {
    const driver = await this.get();
    if (!driver.screenshot)
      throw new Error("Driver does not expose screenshots.");
    return driver.screenshot(target);
  }
  async close() {
    await (await this.connection)?.close();
  }
}

/**
 * Create a local computer-use session without starting a server or reading .env.
 * The native driver and TypeSafe client connect only when a call needs them.
 */
export function createSession(options: SessionOptions = {}): ComputerSession {
  const engine = new DesktopEngine(
    options.driver ?? new LazyDriver(),
    options.choose ?? createChooser(),
  );
  const runtime = new ComputerRepl(engine);
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closing) throw new Error("Session is closed. Create a new session.");
  };
  return {
    async execute(code, signal, timeoutMs) {
      assertOpen();
      return runtime.execute(code, signal, timeoutMs);
    },
    async reset() {
      assertOpen();
      await runtime.reset();
    },
    close() {
      closing ??= (async () => {
        try {
          await runtime.close();
        } finally {
          await engine.shutdown();
        }
      })();
      return closing;
    },
  };
}
