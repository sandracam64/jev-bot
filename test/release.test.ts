import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPublishedVersions,
  compareVersions,
  ensureReleaseAssets,
  fileManifest,
  nextMetadata,
  npmTag,
  packageName,
  parseVersion,
  registryJson,
  validateBranch,
  validateMetadata,
  verifyJsrVersion,
  verifyNpmArchiveMetadata,
  verifyNpmVersion,
} from "../scripts/release-lib.mjs";

function metadata(version = "0.1.0") {
  return [
    { name: packageName, version, publishConfig: { access: "public" } },
    {
      name: packageName,
      version,
      packages: {
        "": { name: packageName, version },
        "node_modules/example": { version: "4.0.0" },
      },
    },
    { name: packageName, version, exports: { ".": "./dist/index.js" } },
  ];
}

test("release versions use canonical stable or rc SemVer", () => {
  for (const value of ["0.0.0", "1.2.3", "10.20.30-rc.0", "1.0.0-rc.12"])
    assert.equal(parseVersion(value).version, value);
  for (const value of [
    "v1.0.0",
    "01.0.0",
    "1.2",
    "1.2.3-rc.01",
    "1.2.3-rc",
    "1.2.3-beta.1",
    "1.2.3+build.1",
    "1.2.3\n",
    "1.2.3; echo bad",
  ])
    assert.throws(() => parseVersion(value));
});

test("release ordering handles multi-digit numbers and rc promotion", () => {
  for (const [a, b] of [
    ["0.1.10", "0.1.9"],
    ["1.0.0-rc.10", "1.0.0-rc.9"],
    ["1.0.0", "1.0.0-rc.99"],
    ["2.0.0-rc.1", "1.99.99"],
  ]) {
    assert.equal(compareVersions(a, b), 1);
    assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});

test("only the matching release line is accepted", () => {
  assert.equal(validateBranch("1.2.3-rc.1", "release/1.2").line, "1.2");
  for (const branch of [
    "main",
    "staging",
    "dev",
    "release/1",
    "release/1.3",
    "release/01.2",
    "",
    "refs/tags/v1.2.3",
  ])
    assert.throws(() => validateBranch("1.2.3", branch));
});

test("metadata must agree across both registries and the lockfile", () => {
  assert.equal(validateMetadata(...metadata()), "0.1.0");
  const [pkg, lock, jsr] = metadata();
  assert.throws(() => validateMetadata({ ...pkg, private: true }, lock, jsr));
  assert.throws(() =>
    validateMetadata(pkg, { ...lock, version: "0.1.1" }, jsr),
  );
  assert.throws(() => validateMetadata(pkg, lock, { ...jsr, name: "jev-bot" }));
});

test("prepare updates all versions without mutating source objects or dependencies", () => {
  const before = metadata();
  const after = nextMetadata(...before, "0.1.1-rc.1", "release/0.1");
  assert.equal(validateMetadata(...after), "0.1.1-rc.1");
  assert.equal(validateMetadata(...before), "0.1.0");
  assert.equal(after[1].packages["node_modules/example"].version, "4.0.0");
  assert.throws(() => nextMetadata(...before, "0.1.0", "release/0.1"));
  assert.throws(() => nextMetadata(...before, "0.0.9", "release/0.0"));
});

test("maintenance and rc releases cannot move a newer npm channel backwards", () => {
  assert.equal(npmTag("1.0.0"), "latest");
  assert.equal(npmTag("1.1.0-rc.1"), "next");
  assert.equal(npmTag("0.1.2", { latest: "1.0.0" }), "release-0.1");
  assert.equal(npmTag("1.0.1-rc.1", { next: "2.0.0-rc.1" }), "release-1.0-rc");
  assert.equal(npmTag("2.0.0", { latest: "1.0.0" }), "latest");
});

test("new releases increase within their line; partly published releases can resume", () => {
  assert.throws(() =>
    checkPublishedVersions("0.1.1", { versions: { "0.1.2": {} } }, null),
  );
  assert.throws(() =>
    checkPublishedVersions("0.1.2-rc.3", null, { versions: { "0.1.2": {} } }),
  );
  assert.doesNotThrow(() =>
    checkPublishedVersions("0.1.3", { versions: { "1.0.0": {} } }, null),
  );
  assert.doesNotThrow(() =>
    checkPublishedVersions(
      "0.1.1",
      { versions: { "0.1.1": {}, "0.1.2": {} } },
      null,
    ),
  );
});

test("an npm retry verifies identity and exact tarball integrity", () => {
  const published = {
    name: packageName,
    version: "0.1.0",
    dist: { integrity: "sha512-same" },
  };
  assert.doesNotThrow(() =>
    verifyNpmVersion(published, "sha512-same", "0.1.0"),
  );
  assert.throws(() => verifyNpmVersion(published, "sha512-different", "0.1.0"));
  assert.throws(() => verifyNpmVersion(published, "sha512-same", "0.1.1"));
});

test("the npm archive must identify the reviewed package and version", () => {
  assert.doesNotThrow(() =>
    verifyNpmArchiveMetadata({ name: packageName, version: "0.1.0" }, "0.1.0"),
  );
  assert.throws(() =>
    verifyNpmArchiveMetadata(
      { name: "@elsewhere/package", version: "0.1.0" },
      "0.1.0",
    ),
  );
  assert.throws(() =>
    verifyNpmArchiveMetadata({ name: packageName, version: "0.1.1" }, "0.1.0"),
  );
});

function assetFixture(
  existing: Record<string, Buffer>,
  expected: Record<string, Buffer>,
) {
  const stored = { ...existing };
  const uploads: string[] = [];
  return {
    uploads,
    stored,
    transport: {
      list: async () =>
        Object.entries(stored).map(([name, bytes]) => ({
          name,
          size: bytes.length,
          state: "uploaded",
        })),
      download: async (asset: { name: string }) => stored[asset.name],
      upload: async (name: string) => {
        uploads.push(name);
        stored[name] = expected[name]!;
      },
    },
  };
}

test("GitHub retry verifies present assets and uploads only the missing receipt", async () => {
  const expected = {
    "package.tgz": Buffer.from("archive"),
    "release.json": Buffer.from("receipt"),
  };
  const fixture = assetFixture(
    { "package.tgz": expected["package.tgz"] },
    expected,
  );
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
});

test("GitHub mismatch stops before uploading anything else", async () => {
  const expected = {
    "package.tgz": Buffer.from("archive"),
    "release.json": Buffer.from("receipt"),
  };
  const fixture = assetFixture(
    { "release.json": Buffer.from("changed") },
    expected,
  );
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /differs from this release/,
  );
  assert.deepEqual(fixture.uploads, []);
  assert.equal(fixture.stored["release.json"].toString(), "changed");
});

test("a lost GitHub upload response is recovered by verifying bytes on the next run", async () => {
  const expected = { "release.json": Buffer.from("receipt") };
  const fixture = assetFixture({}, expected);
  const upload = fixture.transport.upload;
  fixture.transport.upload = async (name) => {
    await upload(name);
    throw new Error("Connection lost after upload");
  };
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /Connection lost/,
  );
  await ensureReleaseAssets(expected, fixture.transport);
  assert.deepEqual(fixture.uploads, ["release.json"]);
});

test("GitHub upload success still requires a byte-for-byte readback", async () => {
  const expected = { "release.json": Buffer.from("receipt") };
  const fixture = assetFixture({}, expected);
  fixture.transport.upload = async (name) => {
    fixture.stored[name] = Buffer.from("changed");
  };
  await assert.rejects(
    ensureReleaseAssets(expected, fixture.transport),
    /differs from this release/,
  );
});

test("a JSR retry verifies every filename, byte count, hash, and export", () => {
  const manifest = { "/dist/index.js": { size: 4, checksum: "sha256-same" } };
  const exports = { ".": "./dist/index.js" };
  assert.doesNotThrow(() =>
    verifyJsrVersion({ manifest, exports }, manifest, exports),
  );
  assert.throws(() =>
    verifyJsrVersion(
      {
        manifest: {
          ...manifest,
          "/extra": { size: 1, checksum: "sha256-extra" },
        },
        exports,
      },
      manifest,
      exports,
    ),
  );
  assert.throws(() =>
    verifyJsrVersion(
      {
        manifest: {
          "/dist/index.js": { size: 4, checksum: "sha256-different" },
        },
        exports,
      },
      manifest,
      exports,
    ),
  );
  assert.throws(() =>
    verifyJsrVersion(
      { manifest, exports: { ".": "./other.js" } },
      manifest,
      exports,
    ),
  );
});

test("the staged JSR manifest hashes actual bytes recursively", async () => {
  const path = await mkdtemp(join(tmpdir(), "jev-bot-release-"));
  try {
    await mkdir(join(path, "dist"));
    await writeFile(join(path, "dist/index.js"), "hello");
    const manifest = await fileManifest(path);
    assert.deepEqual(manifest, {
      "/dist/index.js": {
        size: 5,
        checksum:
          "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    });
  } finally {
    await rm(path, { recursive: true });
  }
});

test("registry absence requires 404, while outages and bad replies stop publishing", async () => {
  assert.equal(
    await registryJson(
      "https://example.test",
      async () => new Response(null, { status: 404 }),
    ),
    null,
  );
  assert.deepEqual(
    await registryJson("https://example.test", async () =>
      Response.json({ version: "0.1.0" }),
    ),
    { version: "0.1.0" },
  );
  for (const status of [401, 403, 429, 500, 503])
    await assert.rejects(
      registryJson(
        "https://example.test",
        async () => new Response(null, { status }),
      ),
      /Registry request failed/,
    );
  await assert.rejects(
    registryJson("https://example.test", async () => new Response("not JSON")),
  );
});

test("release CLI checks a real branch and prepares only reviewable metadata changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-bot-release-cli-"));
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GITHUB_") || name.startsWith("GIT_")) delete env[name];
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, env, stdio: "ignore" });
  const release = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(directory, "scripts/release.mjs"), ...args],
      { cwd: directory, env, encoding: "utf8" },
    );
  try {
    await mkdir(join(directory, "scripts"));
    for (const name of ["release.mjs", "release-lib.mjs"])
      await cp(
        new URL(`../scripts/${name}`, import.meta.url),
        join(directory, "scripts", name),
      );
    const names = ["package.json", "package-lock.json", "jsr.json"];
    const values = metadata();
    for (const [index, name] of names.entries())
      await writeFile(join(directory, name), JSON.stringify(values[index]));
    git("init", "-b", "release/0.1");
    git("add", ".");
    git(
      "-c",
      "user.name=Release test",
      "-c",
      "user.email=release@example.test",
      "commit",
      "-m",
      "fixture",
    );
    assert.equal(release("check", "0.1.0").status, 0);
    assert.notEqual(release("check", "0.1.1").status, 0);
    assert.notEqual(release("publish", "0.1.0").status, 0);
    git("switch", "-c", "main");
    assert.match(release("check").stderr, /must use branch release\/0\.1/);
    git("switch", "release/0.1");
    const prepared = release("prepare", "0.1.1-rc.1");
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const name of names)
      assert.equal(
        JSON.parse(await readFile(join(directory, name), "utf8")).version,
        "0.1.1-rc.1",
      );
    assert.match(release("prepare", "0.1.1").stderr, /Commit or set aside/);
    const commits = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: directory,
      env,
      encoding: "utf8",
    }).trim();
    assert.equal(commits, "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
