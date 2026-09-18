import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import type { DesktopEngine } from "./engine.js";
import type { Element, Observation, RunRequest, Target } from "./types.js";

export const DOCUMENTATION = `Computer use through CUA and Jev. JavaScript bindings persist between js calls.
Start with await cua.getState() or let app = await cua.getApp("App name or bundle ID").
getApp selects one running app with one visible window and emits its accessibility state.
For multiple windows use await cua.getWindow(pid, windowId) from getState's inventory.

cua.getState({emit?:boolean}); cua.listApps({emit?:boolean});
app.getAXState({emit?:boolean,disableDiffing?:boolean,query?:string});
app.getScreenshot({emit?:boolean}); app.getAXStateAndScreenshot({emit?:boolean});
app.click(index); app.setValue(index, "exact text"); app.pressKey("Return");
app.typeText("exact text") targets the unique editable field most recently selected by index with click/setValue.
app.click("description") and app.setValue("field description", "exact text") use Jev to select an observed element.
app.act("bounded goal", {text?:string, keys?:string[], expect?:{role?:string,labelEquals?:string,valueEquals?:string}, maxSteps?:number});

Use nodeRepl.write(value) for text and await nodeRepl.emitImage(bytes) for image output.
Discovery and observation methods emit their own output. Do not wrap them in write/emitImage.
After direct actions, call getAXState before choosing another target. Screenshot-only calls invalidate indices.
Batch deterministic actions with a final state read. Await every API call. Do not use Promise.all for UI calls.
Jev act calls observe, select one allowed action, execute and read back. maxSteps is 1..8, default 4.
Status verified means the caller's exact positive predicate matched one returned element. Partial trees cannot prove absence or global uniqueness.
Unknown delivery is never retried. Handoff means the host must interpret fresh evidence or provide missing inputs.
Jev sees accessibility text, never screenshots. The host handles visual interpretation. This first version supports native AX clicks,
field text and a small navigation-key set. Browser tabs, app launching, coordinate clicks, dragging, scrolling and clipboard paste are not implemented.
No arbitrary shell or filesystem operations belong in this tool. Only perform actions authorized by the user's task.`;

const optionsSchema = z
  .object({
    emit: z.boolean().optional(),
    disableDiffing: z.boolean().optional(),
    query: z.string().max(1000).optional(),
  })
  .strict()
  .default({});
const runOptionsSchema = z
  .object({
    text: z.string().max(8000).optional(),
    keys: z.array(z.string()).max(16).optional(),
    expect: z
      .object({
        role: z.string().optional(),
        labelEquals: z.string().optional(),
        valueEquals: z.string().optional(),
      })
      .strict()
      .optional(),
    maxSteps: z.number().int().min(1).max(8).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    query: z.string().max(1000).optional(),
  })
  .strict()
  .default({});
type AppHandle = {
  target: Target;
  observation?: Observation;
  lines?: Map<number, string>;
  editTarget?: { role: string; label?: string };
};
type EnginePort = Pick<
  DesktopEngine,
  "listApps" | "listWindows" | "observe" | "screenshot" | "execute" | "run"
>;
type Active = {
  outputs: ContentBlock[];
  controller: AbortController;
  calls: Set<Promise<void>>;
};

function records(value: unknown): Record<string, unknown>[] {
  return z.array(z.record(z.unknown())).parse(value);
}
function editable(element: Element) {
  return (
    ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].includes(
      element.role,
    ) &&
    !element.secure &&
    !element.inWebContent &&
    !/password|passcode|secure/i.test(`${element.role} ${element.label ?? ""}`)
  );
}
function line(element: Element): string {
  return (
    `[${element.index}] ${element.role} ${JSON.stringify(element.label ?? "")}` +
    (element.value !== undefined
      ? ` value=${JSON.stringify(element.value)}`
      : "") +
    (element.enabled === false ? " disabled" : "") +
    ` actions=${element.actions.join(",")}`
  );
}

export class ComputerRepl {
  private worker?: Worker;
  private active?: Active;
  private handles = new Map<string, AppHandle>();
  private snapshots = new Map<string, string>();
  private documented = false;
  private sequence = 0;
  private cancelActive?: () => void;
  constructor(private readonly engine: EnginePort) {}

  async execute(
    code: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<CallToolResult> {
    if (this.active)
      throw new Error(
        "Another JavaScript call is running. Wait before continuing.",
      );
    if (!code.trim() || code.length > 50_000)
      throw new Error("Supply 1 to 50000 characters of JavaScript.");
    if (signal?.aborted)
      return {
        content: [{ type: "text", text: "Cancelled before execution." }],
        isError: true,
      };
    const worker = (this.worker ??= this.createWorker());
    const evaluationId = ++this.sequence;
    const active: Active = {
      outputs: [],
      controller: new AbortController(),
      calls: new Set(),
    };
    this.active = active;
    if (!this.documented) {
      active.outputs.push({ type: "text", text: DOCUMENTATION });
      this.documented = true;
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
        if (error) active.outputs.push({ type: "text", text: error });
        this.active = undefined;
        this.cancelActive = undefined;
        resolve({
          content: active.outputs.length
            ? active.outputs
            : [{ type: "text", text: "Executed." }],
          ...(error ? { isError: true } : {}),
        });
      };
      const stop = (reason: string) => {
        active.controller.abort();
        this.worker = undefined;
        this.handles.clear();
        this.snapshots.clear();
        this.documented = false;
        void worker.terminate();
        finish(
          reason +
            " JavaScript bindings were reset. An in-flight native action may have occurred; observe before continuing.",
        );
      };
      const cancel = () => stop("JavaScript call cancelled.");
      this.cancelActive = cancel;
      const onError = () => stop("JavaScript worker failed.");
      const onExit = () => stop("JavaScript worker exited.");
      const onMessage = (message: {
        type: string;
        method: string;
        args: unknown[];
        id: number;
        evaluationId?: number;
        error?: string;
        value?: string;
      }) => {
        if (finished) return;
        if (message.evaluationId !== evaluationId) {
          if (message.type === "call")
            worker.postMessage({
              type: "result",
              id: message.id,
              error:
                "The originating JavaScript call has finished. Await computer calls.",
            });
          return;
        }
        if (message.type === "call") {
          const task = this.invoke(message.method, message.args, active).then(
            (value) => {
              if (!finished)
                worker.postMessage({ type: "result", id: message.id, value });
            },
            (error) => {
              if (!finished)
                worker.postMessage({
                  type: "result",
                  id: message.id,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Computer call failed.",
                });
            },
          );
          active.calls.add(task);
          void task.finally(() => active.calls.delete(task));
        } else if (message.type === "done") {
          void Promise.allSettled([...active.calls]).then(() => {
            if (message.value && !active.outputs.length)
              active.outputs.push({ type: "text", text: message.value });
            finish(message.error);
          });
        }
      };
      const timer = setTimeout(
        () => stop("JavaScript call timed out."),
        Math.max(1, Math.min(60_000, timeoutMs)),
      );
      signal?.addEventListener("abort", cancel, { once: true });
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage({ type: "eval", code, evaluationId });
    });
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./repl-worker.js", import.meta.url), {
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const discard = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.handles.clear();
      this.snapshots.clear();
      this.documented = false;
    };
    // These listeners remain present while idle, including after an unawaited rejection.
    worker.on("error", discard);
    worker.on("exit", discard);
    worker.on("message", (message) => {
      if (!this.active && message.type === "call") {
        worker.postMessage({
          type: "result",
          id: message.id,
          error: "No JavaScript call is active. Await computer calls.",
        });
      }
    });
    return worker;
  }

  private emitImage(active: Active, image: { data: string; mimeType: string }) {
    if (active.controller.signal.aborted) return;
    if (active.outputs.length >= 32 || image.data.length > 12_000_000)
      throw new Error("Image output limit reached.");
    active.outputs.push({ type: "image", ...image });
  }

  async reset(): Promise<void> {
    if (this.active)
      throw new Error(
        "Wait for the running call to finish or cancel it before resetting.",
      );
    await this.worker?.terminate();
    this.worker = undefined;
    this.handles.clear();
    this.snapshots.clear();
    this.documented = false;
  }

  async close(): Promise<void> {
    this.cancelActive?.();
    await this.reset();
  }

  private emit(active: Active, value: unknown) {
    if (active.controller.signal.aborted) return;
    if (active.outputs.length >= 32)
      throw new Error("Output limit reached. Use fewer output calls.");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length > 100_000)
      throw new Error(
        "Output is too large. Narrow the observation with query.",
      );
    active.outputs.push({ type: "text", text });
  }
  private key(target: Target) {
    return `${target.pid}:${target.windowId}`;
  }
  private invalidate(handle: AppHandle) {
    this.snapshots.delete(this.key(handle.target));
  }
  private async read(
    handle: AppHandle,
    options: z.infer<typeof optionsSchema>,
    active: Active,
  ) {
    const observation = await this.engine.observe(handle.target, options.query);
    handle.observation = observation;
    this.snapshots.set(this.key(handle.target), observation.snapshotId);
    const lines = new Map(
      observation.elements.map((element) => [element.index, line(element)]),
    );
    let text = `${observation.appName}: ${observation.windowTitle}\n`;
    if (handle.lines && !options.disableDiffing) {
      const diff = [...lines]
        .filter(([index, value]) => handle.lines?.get(index) !== value)
        .map(([, value]) => `+ ${value}`);
      const removed = [...handle.lines.keys()]
        .filter((index) => !lines.has(index))
        .map((index) => `- [${index}]`);
      text +=
        diff.length || removed.length
          ? [...removed, ...diff].join("\n")
          : "No accessibility changes.";
    } else text += [...lines.values()].join("\n");
    if (!observation.complete)
      text += "\nObservation is partial. Omitted elements are unknown.";
    if (observation.degraded)
      text +=
        "\nAccessibility is degraded. Use a screenshot and hand off to the host.";
    handle.lines = lines;
    if (options.emit !== false) this.emit(active, text);
    return text;
  }
  private element(handle: AppHandle, index: unknown): Element {
    if (
      !Number.isSafeInteger(index) ||
      !handle.observation ||
      this.snapshots.get(this.key(handle.target)) !==
        handle.observation.snapshotId
    ) {
      throw new Error("Read fresh getAXState() before using an element index.");
    }
    const matches = handle.observation.elements.filter(
      (element) => element.index === index,
    );
    const element = matches[0];
    if (
      matches.length !== 1 ||
      !element?.token ||
      element.enabled !== true ||
      element.secure ||
      element.inWebContent
    ) {
      throw new Error(
        "The index is not one enabled native accessibility target.",
      );
    }
    return element;
  }

  private async invoke(
    method: string,
    args: unknown[],
    active: Active,
  ): Promise<unknown> {
    if (active.controller.signal.aborted) throw new Error("Call cancelled.");
    if (method === "write") {
      this.emit(active, args[0]);
      return;
    }
    if (method === "emitImage") {
      const bytes = args[0];
      if (!(bytes instanceof Uint8Array) || bytes.length > 8_000_000)
        throw new Error("Pass PNG screenshot bytes of at most 8 MB.");
      this.emitImage(active, {
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "image/png",
      });
      return;
    }
    if (method === "getState" || method === "listApps") {
      const options = optionsSchema.parse(args[0]);
      const apps = await this.engine.listApps();
      const state =
        method === "getState"
          ? { ...apps, ...(await this.engine.listWindows()) }
          : apps;
      if (options.emit !== false) this.emit(active, state);
      return state;
    }
    if (method === "getApp" || method === "getWindow") {
      let target: Target;
      if (method === "getApp") {
        const name = z.string().min(1).parse(args[0]);
        const apps = records((await this.engine.listApps()).apps).filter(
          (app) =>
            app.running === true &&
            [app.name, app.bundle_id, app.launch_path].includes(name),
        );
        if (apps.length !== 1)
          throw new Error(
            "Select one running app by its exact name or bundle ID from cua.listApps(). App launching is not implemented.",
          );
        const windows = records(
          (await this.engine.listWindows()).windows,
        ).filter(
          (window) =>
            window.pid === apps[0]?.pid && window.is_on_screen === true,
        );
        if (windows.length !== 1)
          throw new Error(
            "Select an exact window with cua.getWindow(pid, windowId) from cua.getState().",
          );
        target = {
          pid: z.number().int().positive().parse(windows[0]?.pid),
          windowId: z.number().int().positive().parse(windows[0]?.window_id),
        };
      } else
        target = {
          pid: z.number().int().positive().parse(args[0]),
          windowId: z.number().int().positive().parse(args[1]),
        };
      const id = randomUUID();
      const handle: AppHandle = { target };
      await this.read(handle, { disableDiffing: true }, active);
      this.handles.set(id, handle);
      return id;
    }
    const handle = this.handles.get(String(args[0]));
    if (!handle) throw new Error("App handle expired. Select the app again.");
    if (method === "getAXState")
      return this.read(handle, optionsSchema.parse(args[1]), active);
    if (method === "getScreenshot" || method === "getAXStateAndScreenshot") {
      const options = optionsSchema.parse(args[1]);
      this.invalidate(handle);
      const image = await this.engine.screenshot(handle.target);
      if (options.emit !== false) this.emitImage(active, image);
      const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
      if (method === "getScreenshot") return bytes;
      const state = await this.read(
        handle,
        { ...options, disableDiffing: true },
        active,
      );
      return { state, screenshot: bytes };
    }
    if (
      method === "act" ||
      (["click", "setValue"].includes(method) && typeof args[1] === "string")
    ) {
      const goal = z.string().min(1).max(8000).parse(args[1]);
      const options = method === "act" ? runOptionsSchema.parse(args[2]) : {};
      const request: RunRequest = {
        ...options,
        target: handle.target,
        goal:
          method === "click"
            ? `Click the target described as: ${goal}`
            : method === "setValue"
              ? `Replace the value of the field described as ${goal} with the supplied exact text.`
              : goal,
        ...(method === "click" ? { maxSteps: 1, allowedKinds: ["click"] } : {}),
        ...(method === "setValue"
          ? {
              maxSteps: 1,
              allowedKinds: ["set_value"],
              text: z.string().max(8000).parse(args[2]),
            }
          : {}),
      };
      this.invalidate(handle);
      handle.editTarget = undefined;
      const result = await this.engine.run(request, active.controller.signal);
      this.emit(active, result);
      if (result.observation) {
        handle.observation = result.observation;
        this.snapshots.set(
          this.key(handle.target),
          result.observation.snapshotId,
        );
      }
      handle.lines = undefined;
      return result;
    }
    if (method === "click" || method === "setValue") {
      const element = this.element(handle, args[1]);
      if (method === "click" && !element.actions.includes("AXPress"))
        throw new Error("Element does not advertise AXPress.");
      if (method === "setValue" && !editable(element))
        throw new Error("Element is not an editable native text field.");
      this.invalidate(handle);
      const action =
        method === "click"
          ? {
              kind: "click" as const,
              target: handle.target,
              elementToken: element.token!,
            }
          : {
              kind: "set_value" as const,
              target: handle.target,
              elementToken: element.token!,
              value: z.string().max(8000).parse(args[2]),
            };
      const receipt = await this.engine.execute(action);
      handle.editTarget = editable(element)
        ? { role: element.role, label: element.label }
        : undefined;
      this.emit(active, receipt);
      return receipt;
    }
    if (method === "typeText") {
      if (!handle.editTarget)
        throw new Error(
          "Use setValue(index, text) to select an editable field first.",
        );
      const selected = handle.editTarget;
      await this.read(handle, { emit: false }, active);
      if (active.controller.signal.aborted)
        throw new Error("Call cancelled before text input.");
      const matches = handle.observation!.elements.filter(
        (element) =>
          editable(element) &&
          element.role === selected.role &&
          element.label === selected.label,
      );
      if (matches.length !== 1)
        throw new Error(
          "The selected field is now ambiguous. Use setValue with a fresh index.",
        );
      const element = this.element(handle, matches[0]!.index);
      this.invalidate(handle);
      const receipt = await this.engine.execute({
        kind: "type_text",
        target: handle.target,
        elementToken: element.token!,
        text: z.string().max(8000).parse(args[1]),
      });
      this.emit(active, receipt);
      return receipt;
    }
    if (method === "pressKey") {
      const key = z
        .enum([
          "return",
          "tab",
          "escape",
          "space",
          "backspace",
          "delete",
          "up",
          "down",
          "left",
          "right",
          "home",
          "end",
          "pageup",
          "pagedown",
        ])
        .parse(String(args[1]).toLowerCase());
      this.invalidate(handle);
      handle.editTarget = undefined;
      const receipt = await this.engine.execute({
        kind: "press_key",
        target: handle.target,
        key,
      });
      this.emit(active, receipt);
      return receipt;
    }
    throw new Error("Unsupported computer method.");
  }
}
