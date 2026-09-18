export interface CliArguments {
  command: "stdio" | "doctor" | "--help" | "-h";
  envFile?: string;
}

/** Parse only the documented command and optional explicit environment file. */
export function parseCliArguments(args: readonly string[]): CliArguments {
  let command: CliArguments["command"] | undefined;
  let envFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--env-file") {
      const value = args[++index];
      if (envFile !== undefined || !value || value.startsWith("--"))
        throw new Error("Supply one --env-file followed by its path.");
      envFile = value;
    } else if (
      !command &&
      ["stdio", "doctor", "--help", "-h"].includes(arg ?? "")
    ) {
      command = arg as CliArguments["command"];
    } else {
      throw new Error(
        "Use jev-bot [stdio|doctor] [--env-file /absolute/path/.env].",
      );
    }
  }
  return { command: command ?? "stdio", ...(envFile ? { envFile } : {}) };
}
