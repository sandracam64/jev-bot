import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed.\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function checkFiles(pack) {
  assert(
    Array.isArray(pack.files) && pack.files.length > 0,
    "npm pack returned no files",
  );
  for (const file of pack.files) {
    assert(
      /^(?:package\.json|README\.md|LICENSE|NOTICE|dist\/[a-z][a-z0-9-]*\.(?:js|d\.ts))$/.test(
        file.path,
      ),
      `Unexpected npm package file: ${file.path}`,
    );
  }
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli.js",
    "dist/repl-worker.js",
  ]) {
    assert(
      pack.files.some((file) => file.path === required),
      `Missing npm package file: ${required}`,
    );
  }
}

function npmSpecifier(specifier, versions) {
  if (/^(?:\.{1,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return specifier;
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const version = versions[name];
  assert(version, `Published import has no locked dependency: ${specifier}`);
  return `npm:${name}@${version}${specifier.slice(name.length)}`;
}

// Pre-expand dependencies so JSR uploads these exact bytes. That makes a retry
// able to compare registry checksums against the reviewed release artifact.
function expandJsrImports(file, text, versions) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const add = (literal) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const expanded = npmSpecifier(literal.text, versions);
    if (expanded !== literal.text) {
      edits.push({
        start: literal.getStart(source),
        end: literal.end,
        text: JSON.stringify(expanded),
      });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text.replace(
    /(@ts-(?:self-)?types\s*=\s*)(["'])([^"']+)\2/g,
    (_match, prefix, _quote, specifier) =>
      `${prefix}${JSON.stringify(npmSpecifier(specifier, versions))}`,
  );
}

run(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const jsr = JSON.parse(await readFile(join(root, "jsr.json"), "utf8"));
assert.equal(manifest.name, "@compootor/jev-bot");
assert.equal(jsr.name, manifest.name);
assert.equal(jsr.version, manifest.version);
assert.notEqual(manifest.private, true, "The npm package must be public");
assert.equal(manifest.bin?.["jev-bot"], "./dist/cli.js");

const npmDirectory = join(root, ".release/npm");
const jsrDirectory = join(root, ".release/jsr");
await rm(npmDirectory, { recursive: true, force: true });
await mkdir(npmDirectory, { recursive: true });
const preview = JSON.parse(
  run(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"]),
)[0];
checkFiles(preview);
const packed = JSON.parse(
  run(npm, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    npmDirectory,
  ]),
)[0];
checkFiles(packed);
assert.deepEqual(
  packed.files,
  preview.files,
  "npm package contents changed between inspection and packing",
);
const tarball = join(npmDirectory, packed.filename);

await rm(jsrDirectory, { recursive: true, force: true });
await mkdir(jsrDirectory, { recursive: true });
for (const path of ["dist", "README.md", "LICENSE", "NOTICE", "jsr.json"]) {
  await cp(join(root, path), join(jsrDirectory, path), { recursive: true });
}
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
const lockedDependencies = Object.fromEntries(
  Object.keys(manifest.dependencies).map((name) => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    assert(
      version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
      `Missing exact locked version for ${name}`,
    );
    return [name, version];
  }),
);
for (const file of await readdir(join(jsrDirectory, "dist"))) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
  const path = join(jsrDirectory, "dist", file);
  await writeFile(
    path,
    expandJsrImports(file, await readFile(path, "utf8"), lockedDependencies),
  );
}
await writeFile(
  join(jsrDirectory, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      type: "module",
      dependencies: lockedDependencies,
      devDependencies: {
        "@types/node": lock.packages["node_modules/@types/node"].version,
      },
    },
    null,
    2,
  ) + "\n",
);

const temporary = await mkdtemp(join(tmpdir(), "jev-bot-package-"));
try {
  await writeFile(
    join(temporary, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: temporary },
  );
  const consumer = join(temporary, "consumer.mts");
  await writeFile(
    consumer,
    `import { createSession, createServer, type ComputerSession } from "@compootor/jev-bot";\nconst session: ComputerSession = createSession();\nconst server = createServer(session);\nconst result = session.execute("await nodeRepl.write(42)");\nvoid server;\nvoid result;\n`,
  );
  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--typeRoots",
      join(root, "node_modules/@types"),
      consumer,
    ],
    { cwd: temporary },
  );
  console.log("Installed package: TypeScript consumer declarations passed.");
  // No credentials or driver access are needed for the package contract.
  const env = {
    ...process.env,
    TYPESAFE_API_KEY: "",
    CUA_DRIVER_BIN: join(temporary, "no-driver"),
  };
  const code = `
import assert from "node:assert/strict";
import { createSession } from "@compootor/jev-bot";
const session = createSession();
try {
  const first = await session.execute("let packagedValue = 40; await nodeRepl.write(packagedValue + 2)");
  assert(!first.isError, JSON.stringify(first));
  assert(first.content.some(item => item.type === "text" && item.text.includes("42")));
  const next = await session.execute("await nodeRepl.write(packagedValue)");
  assert(!next.isError);
  assert(next.content.some(item => item.type === "text" && item.text.includes("40")));
  await session.reset();
  const cleared = await session.execute("await nodeRepl.write(typeof packagedValue)");
  assert(!cleared.isError);
  assert(cleared.content.some(item => item.type === "text" && item.text.includes("undefined")));
} finally {
  await session.close();
}
console.log("Installed package: import, worker, persistent bindings, reset, and close passed.");
`;
  console.log(
    run(process.execPath, ["--input-type=module", "-e", code], {
      cwd: temporary,
      env,
    }).trim(),
  );
  const cli = join(temporary, "node_modules/@compootor/jev-bot/dist/cli.js");
  const help = run(process.execPath, [cli, "--help"], { cwd: temporary, env });
  assert(
    help.includes("jev-bot"),
    "Installed CLI help did not identify jev-bot",
  );
  const bin = join(
    temporary,
    "node_modules/.bin",
    process.platform === "win32" ? "jev-bot.cmd" : "jev-bot",
  );
  const binHelp = run(bin, ["--help"], {
    cwd: temporary,
    env,
    shell: process.platform === "win32",
  });
  assert.equal(binHelp, help, "Installed bin shortcut did not match CLI help");
  console.log("Installed CLI: jev-bot bin shortcut passed.");
  const stdioCode = `
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "package-contract", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(cli)}], env: { ...process.env }, stderr: "pipe" });
transport.stderr?.resume();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["js", "reset"]);
  const result = await client.callTool({ name: "js", arguments: { code: "await nodeRepl.write(21 * 2)" } });
  assert(!result.isError, JSON.stringify(result));
  assert(result.content.some(item => item.type === "text" && item.text.includes("42")));
  assert.equal(client.getServerVersion()?.version, ${JSON.stringify(manifest.version)});
  await client.callTool({ name: "reset", arguments: {} });
} finally {
  await client.close();
}
console.log("Installed CLI: MCP handshake, version, tools, JavaScript, and reset passed.");
`;
  console.log(
    run(process.execPath, ["--input-type=module", "-e", stdioCode], {
      cwd: temporary,
      env,
    }).trim(),
  );
  console.log(`npm archive: .release/npm/${packed.filename}`);
  console.log(
    "JSR package staged at .release/jsr. Run deno publish --dry-run there to validate JSR.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
