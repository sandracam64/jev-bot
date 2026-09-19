import { connectDriver } from "./driver.js";
import { DesktopEngine } from "./engine.js";
import { createChooser } from "./provider.js";
import { ComputerRepl } from "./repl.js";
import type { ReplRuntimePort } from "./server.js";
import type { Choose, Driver, NativeAction, Target } from "./types.js";

/** Optional adapters for embedding or testing a session. */
export interface SessionOptions {
  /** Native desktop adapter. Defaults to a connection opened on first use. */
  driver?: Driver;
  /** Action chooser. Defaults to TypeSafe Jev, contacted only when needed. */
  choose?: Choose;
}

/** A persistent JavaScript session that owns its native connection. */
export interface ComputerSession extends ReplRuntimePort {
  /**
   * Cancel active JavaScript, drain native input, and close the connection.
   * Repeated calls return the same close operation. The session cannot reopen.
   */
  close(): Promise<void>;
}

/** Connect to Cua Driver on the first desktop call, keeping one connection. */
export class LazyDriver implements Driver {
  private connection?: Promise<Driver>;
  private get(): Promise<Driver> {
    return (this.connection ??= connectDriver().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    }));
  }
  /** List available windows, opening the native connection if needed. */
  async listWindows() {
    return (await this.get()).listWindows();
  }
  /** List running apps, or reject if the driver lacks app discovery. */
  async listApps() {
    const driver = await this.get();
    if (!driver.listApps)
      throw new Error("Driver does not expose app discovery.");
    return driver.listApps();
  }
  /** Read accessibility state, optionally filtered by a query. */
  async observe(target: Target, query?: string) {
    return (await this.get()).observe(target, query);
  }
  /** Perform one native input operation and return its receipt. */
  async execute(action: NativeAction) {
    return (await this.get()).execute(action);
  }
  /** Capture a window, or reject if the driver lacks screenshot support. */
  async screenshot(target: Target) {
    const driver = await this.get();
    if (!driver.screenshot)
      throw new Error("Driver does not expose screenshots.");
    return driver.screenshot(target);
  }
  /** Close an existing connection without opening one. */
  async close() {
    await (await this.connection)?.close();
  }
}

/**
 * Create a local computer-use session without starting a server or reading .env.
 * The native driver and TypeSafe client connect only when a call needs them.
 * Close the session when finished, including when an execution fails.
 *
 * @param options Optional native driver and action chooser adapters.
 * @returns A persistent JavaScript session with execute, reset, and close methods.
 *
 * @example
 * ```ts
 * import { createSession } from "@compootor/jev-bot";
 *
 * const session = createSession();
 * try {
 *   const result = await session.execute("await cua.getState();");
 *   console.log(result);
 * } finally {
 *   await session.close();
 * }
 * ```
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
