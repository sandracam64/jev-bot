export type JsonObject = Record<string, unknown>;

export type Target = Readonly<{ pid: number; windowId: number }>;
export type Element = Readonly<{
  token?: string;
  index: number;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  secure?: boolean;
  actions: readonly string[];
  inWebContent?: boolean;
}>;

export type Observation = Readonly<{
  target: Target;
  snapshotId: string;
  appName: string;
  windowTitle: string;
  elements: readonly Element[];
  complete: boolean;
  degraded: boolean;
}>;

export type NativeAction = Readonly<
  | { kind: "click"; target: Target; elementToken: string }
  | { kind: "type_text"; target: Target; elementToken: string; text: string }
  | { kind: "set_value"; target: Target; elementToken: string; value: string }
  | { kind: "press_key"; target: Target; key: string }
>;

export type Candidate = Readonly<{
  id: string;
  description: string;
  action?: NativeAction;
}>;

export type Decision = Readonly<{
  selectedId: string;
  confidence: number;
  probabilities: Readonly<Record<string, number>>;
  model?: string;
}>;

export interface Driver {
  listApps?(): Promise<JsonObject>;
  listWindows(): Promise<JsonObject>;
  observe(target: Target, query?: string): Promise<Observation>;
  screenshot?(target: Target): Promise<{ data: string; mimeType: string }>;
  execute(action: NativeAction): Promise<JsonObject>;
  close(): Promise<void>;
}

export type Choose = (
  goal: string,
  observation: Observation,
  candidates: readonly Candidate[],
  history: readonly JsonObject[],
  signal?: AbortSignal,
) => Promise<Decision>;

export type Expectation = Readonly<{
  role?: string;
  labelEquals?: string;
  valueEquals?: string;
}>;

export type RunRequest = Readonly<{
  goal: string;
  target: Target;
  text?: string;
  keys?: readonly string[];
  query?: string;
  expect?: Expectation;
  maxSteps?: number;
  minConfidence?: number;
  allowedKinds?: readonly NativeAction["kind"][];
}>;

export type RunResult = Readonly<{
  status: "verified" | "handoff" | "budget_exhausted" | "unknown" | "cancelled";
  reason: string;
  history: readonly JsonObject[];
  observation?: Observation;
}>;
