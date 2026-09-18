import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const packageName = "@compootor/jev-bot";
export const repository = "stoopid-computers/jev-bot";

// The release policy is deliberately narrower than SemVer: stable and rc.N only.
export function parseVersion(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(
      version,
    );
  if (!match)
    throw new Error(
      "Use a version such as 0.1.0 or 0.2.0-rc.1. Build metadata is not supported.",
    );
  return {
    version,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    rc: match[4] === undefined ? null : BigInt(match[4]),
    line: `${match[1]}.${match[2]}`,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc > b.rc ? 1 : -1;
}

export function validateBranch(version, branch) {
  const parsed = parseVersion(version);
  if (branch !== `release/${parsed.line}`)
    throw new Error(
      `Version ${version} must use branch release/${parsed.line}; received ${branch || "a detached checkout"}.`,
    );
  return parsed;
}

export function validateMetadata(pkg, lock, jsr) {
  parseVersion(pkg.version);
  if (
    [pkg.name, lock.name, lock.packages?.[""]?.name, jsr.name].some(
      (name) => name !== packageName,
    )
  ) {
    throw new Error(`All package names must be ${packageName}.`);
  }
  if (
    [lock.version, lock.packages?.[""]?.version, jsr.version].some(
      (version) => version !== pkg.version,
    )
  ) {
    throw new Error(
      "package.json, package-lock.json, and jsr.json must have the same version.",
    );
  }
  if (pkg.private === true || pkg.publishConfig?.access !== "public")
    throw new Error("The npm package must allow public publishing.");
  return pkg.version;
}

export function nextMetadata(pkg, lock, jsr, version, branch) {
  const current = validateMetadata(pkg, lock, jsr);
  validateBranch(version, branch);
  if (compareVersions(version, current) <= 0)
    throw new Error(
      `The new version must be greater than ${current}. To release that version unchanged, use release:check.`,
    );
  return [
    { ...pkg, version },
    {
      ...lock,
      version,
      packages: { ...lock.packages, "": { ...lock.packages[""], version } },
    },
    { ...jsr, version },
  ];
}

export function npmTag(version, tags = {}) {
  const parsed = parseVersion(version);
  const desired = parsed.rc === null ? "latest" : "next";
  const current = tags[desired];
  if (current) {
    // Unknown external version formats require review, never silently move a tag.
    if (compareVersions(version, current) < 0)
      return `release-${parsed.line}${parsed.rc === null ? "" : "-rc"}`;
  }
  return desired;
}

export function checkPublishedVersions(version, npm, jsr) {
  const versions = new Set([
    ...Object.keys(npm?.versions ?? {}),
    ...Object.keys(jsr?.versions ?? {}),
  ]);
  // A partly published version can be resumed after its line has moved on.
  if (versions.has(version)) return;
  for (const existing of versions) {
    let parsed;
    try {
      parsed = parseVersion(existing);
    } catch {
      continue;
    }
    if (
      parsed.line === parseVersion(version).line &&
      compareVersions(existing, version) >= 0
    ) {
      throw new Error(
        `${existing} is already published. Choose a newer version in this release line.`,
      );
    }
  }
}

export function verifyNpmVersion(published, integrity, version) {
  if (
    published.name !== packageName ||
    published.version !== version ||
    published.dist?.integrity !== integrity
  ) {
    throw new Error(
      `npm ${version} exists with different bytes or metadata. Do not reuse the version.`,
    );
  }
}

export function verifyNpmArchiveMetadata(metadata, version) {
  if (metadata.name !== packageName || metadata.version !== version) {
    throw new Error(
      "The npm tarball name or version differs from the reviewed release.",
    );
  }
}

// Check all present assets before uploading any missing asset. Never replace bytes.
export async function ensureReleaseAssets(expected, transport) {
  const assets = await transport.list();
  const missing = [];
  async function verify(asset, name, bytes) {
    if (asset.state !== "uploaded" || asset.size !== bytes.length)
      throw new Error(
        `GitHub asset ${name} is incomplete or differs from this release.`,
      );
    if (!Buffer.from(await transport.download(asset)).equals(bytes))
      throw new Error(
        `GitHub asset ${name} differs from this release. Refusing to replace it.`,
      );
  }
  for (const [name, bytes] of Object.entries(expected)) {
    const matches = assets.filter((asset) => asset.name === name);
    if (matches.length > 1)
      throw new Error(`GitHub release has duplicate assets named ${name}.`);
    if (matches.length === 1) await verify(matches[0], name, bytes);
    else missing.push([name, bytes]);
  }
  for (const [name, bytes] of missing) {
    await transport.upload(name);
    const matches = (await transport.list()).filter(
      (asset) => asset.name === name,
    );
    if (matches.length !== 1)
      throw new Error(
        `GitHub asset ${name} was not confirmed after upload. Rerun the workflow.`,
      );
    await verify(matches[0], name, bytes);
  }
}

export function verifyJsrVersion(published, manifest, exports) {
  const sort = (value) =>
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  if (
    JSON.stringify(sort(published.exports ?? {})) !==
    JSON.stringify(sort(exports))
  )
    throw new Error("JSR exports differ from this build.");
  const actual = published.manifest ?? {};
  if (
    JSON.stringify(Object.keys(actual).sort()) !==
    JSON.stringify(Object.keys(manifest).sort())
  )
    throw new Error("JSR files differ from this build.");
  for (const [path, expected] of Object.entries(manifest)) {
    if (
      actual[path].checksum !== expected.checksum ||
      actual[path].size !== expected.size
    )
      throw new Error(`JSR file ${path} differs from this build.`);
  }
}

export async function fileManifest(directory) {
  const manifest = {};
  async function visit(relative = "") {
    const entries = await readdir(join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory, path));
        manifest[`/${path}`] = {
          size: bytes.length,
          checksum: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
        };
      } else throw new Error(`Unexpected file type in JSR package: ${path}`);
    }
  }
  await visit();
  return manifest;
}

export async function registryJson(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Registry request failed with HTTP ${response.status}: ${url}`,
    );
  return response.json();
}
