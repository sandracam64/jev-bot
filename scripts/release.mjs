#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPublishedVersions,
  ensureReleaseAssets,
  fileManifest,
  nextMetadata,
  npmTag,
  packageName,
  registryJson,
  repository,
  validateBranch,
  validateMetadata,
  verifyJsrVersion,
  verifyNpmArchiveMetadata,
  verifyNpmVersion,
} from "./release-lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });
const git = (...args) => run("git", args).trim();
const branch = () =>
  process.env.GITHUB_REF?.startsWith("refs/heads/")
    ? process.env.GITHUB_REF.slice(11)
    : git("branch", "--show-current");

function cleanCheckout() {
  if (git("status", "--porcelain"))
    throw new Error(
      "Commit or set aside your changes before preparing or publishing a release.",
    );
}

async function metadata() {
  const values = await Promise.all(
    ["package.json", "package-lock.json", "jsr.json"].map(json),
  );
  const version = validateMetadata(...values);
  return { values, version };
}

async function check(expected) {
  const { values, version } = await metadata();
  const parsed = validateBranch(version, branch());
  if (expected && expected !== version)
    throw new Error(
      `Requested ${expected}, but the checked-out package is ${version}.`,
    );
  if (process.env.GITHUB_ACTIONS === "true") {
    if (
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== `refs/heads/release/${parsed.line}` ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    ) {
      throw new Error(
        "Releases must be dispatched from the matching release branch in the official repository.",
      );
    }
    if (git("rev-parse", "HEAD") !== process.env.GITHUB_SHA)
      throw new Error("The checkout differs from the workflow commit.");
  }
  return { values, version, parsed };
}

async function github(path, options = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404 && !options.method) return null;
  if (!response.ok)
    throw new Error(
      `GitHub request failed with HTTP ${response.status} for ${path}.`,
    );
  return options.headers?.Accept === "application/octet-stream"
    ? Buffer.from(await response.arrayBuffer())
    : response.json();
}

async function releaseAssets(releaseId) {
  const all = [];
  for (let page = 1; ; page++) {
    const assets = await github(
      `releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(assets))
      throw new Error("GitHub did not return a release asset list.");
    all.push(...assets);
    if (assets.length < 100) return all;
  }
}

async function reserveTag(tag, sha) {
  const existing = await github(`git/ref/tags/${tag}`);
  if (existing) {
    let object = existing.object;
    while (object.type === "tag")
      object = (await github(`git/tags/${object.sha}`)).object;
    if (object.type !== "commit" || object.sha !== sha)
      throw new Error(
        `${tag} already points to another commit. Never move a release tag.`,
      );
    return;
  }
  await github("git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  });
}

async function publish(expected) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.GH_TOKEN ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  )
    throw new Error(
      "Publishing is only supported by the GitHub release workflow with OIDC.",
    );
  if (!expected)
    throw new Error("The release workflow must supply the reviewed version.");
  const { version, parsed } = await check(expected);
  cleanCheckout();
  const sha = git("rev-parse", "HEAD");
  const tag = `v${version}`;
  const npmFiles = (await readdir(join(root, ".release/npm"))).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (npmFiles.length !== 1)
    throw new Error(
      "Run package:check first. Exactly one npm tarball is required.",
    );
  const tarball = join(root, ".release/npm", npmFiles[0]);
  const packedMetadata = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"]),
  );
  verifyNpmArchiveMetadata(packedMetadata, version);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  const jsrDirectory = join(root, ".release/jsr");
  const jsrConfig = JSON.parse(
    await readFile(join(jsrDirectory, "jsr.json"), "utf8"),
  );
  if (jsrConfig.name !== packageName || jsrConfig.version !== version)
    throw new Error("Staged JSR metadata differs from the release.");
  const manifest = await fileManifest(jsrDirectory);
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const jsrUrl = `https://jsr.io/${packageName}`;
  const [npm, jsr, existingJsr] = await Promise.all([
    registryJson(npmUrl),
    registryJson(`${jsrUrl}/meta.json`),
    registryJson(`${jsrUrl}/${version}_meta.json`),
  ]);
  checkPublishedVersions(version, npm, jsr);
  const existingNpm = npm?.versions?.[version];
  if (existingNpm) verifyNpmVersion(existingNpm, integrity, version);
  if (jsr?.versions?.[version]?.yanked)
    throw new Error("This JSR version was yanked; choose a new version.");
  if (existingJsr) verifyJsrVersion(existingJsr, manifest, jsrConfig.exports);
  const distTag = npmTag(version, npm?.["dist-tags"]);
  // Reserve the version before any irreversible registry upload. A retry must use this SHA.
  await reserveTag(tag, sha);
  if (!existingNpm)
    run(
      "npm",
      [
        "publish",
        tarball,
        "--access",
        "public",
        "--tag",
        distTag,
        "--ignore-scripts",
      ],
      { stdio: "inherit" },
    );
  const publishedNpm = await registryJson(`${npmUrl}/${version}`);
  if (!publishedNpm)
    throw new Error(
      "npm has not exposed the version yet. Rerun this workflow after it appears.",
    );
  verifyNpmVersion(publishedNpm, integrity, version);
  if (!existingJsr)
    run("deno", ["publish", "--config", "jsr.json"], {
      cwd: jsrDirectory,
      stdio: "inherit",
    });
  const publishedJsr = await registryJson(`${jsrUrl}/${version}_meta.json`);
  if (!publishedJsr)
    throw new Error(
      "JSR has not exposed the version yet. Rerun this workflow after it appears.",
    );
  verifyJsrVersion(publishedJsr, manifest, jsrConfig.exports);
  const receipt = {
    name: packageName,
    version,
    tag,
    commit: sha,
    branch: branch(),
    npm: {
      url: `https://www.npmjs.com/package/${packageName}/v/${version}`,
      integrity,
    },
    jsr: { url: `${jsrUrl}@${version}`, manifest },
  };
  const receiptPath = join(root, ".release/release.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  let release = await github(`releases/tags/${tag}`);
  if (!release) {
    // gh creates the release only after verifying both registries; argument arrays avoid shell interpolation.
    const args = [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--target",
      sha,
      "--title",
      tag,
      "--generate-notes",
      "--notes",
      `npm: ${receipt.npm.url}\nJSR: ${receipt.jsr.url}\n\nSource commit: ${sha}`,
    ];
    if (parsed.rc !== null) args.push("--prerelease", "--latest=false");
    else args.push(distTag === "latest" ? "--latest" : "--latest=false");
    run("gh", args, { stdio: "inherit" });
    release = await github(`releases/tags/${tag}`);
  }
  if (!release || release.draft || release.prerelease !== (parsed.rc !== null))
    throw new Error("GitHub release status differs from this version.");
  const assetPaths = { [npmFiles[0]]: tarball, "release.json": receiptPath };
  const expectedAssets = Object.fromEntries(
    await Promise.all(
      Object.entries(assetPaths).map(async ([name, path]) => [
        name,
        await readFile(path),
      ]),
    ),
  );
  await ensureReleaseAssets(expectedAssets, {
    list: () => releaseAssets(release.id),
    download: (asset) =>
      github(`releases/assets/${asset.id}`, {
        headers: { Accept: "application/octet-stream" },
      }),
    upload: (name) =>
      run(
        "gh",
        ["release", "upload", tag, assetPaths[name], "--repo", repository],
        { stdio: "inherit" },
      ),
  });
  console.log(
    `Both registries and GitHub release assets are verified for ${tag} at ${sha}.`,
  );
}

async function main(args = process.argv.slice(2)) {
  const [command, version, ...extra] = args;
  if (extra.length) throw new Error("Unexpected release arguments.");
  if (command === "prepare") {
    if (!version) throw new Error("Usage: npm run release:prepare -- 0.1.1");
    cleanCheckout();
    const { values } = await metadata();
    const updated = nextMetadata(...values, version, branch());
    for (const [index, name] of [
      "package.json",
      "package-lock.json",
      "jsr.json",
    ].entries())
      await writeFile(
        join(root, name),
        `${JSON.stringify(updated[index], null, 2)}\n`,
      );
    console.log(
      `Prepared ${version} on ${branch()}. Review and commit the three metadata files, then dispatch release.yml from this branch.`,
    );
  } else if (command === "check") {
    const result = await check(version);
    console.log(
      `${result.version} matches ${branch()} and all package metadata.`,
    );
  } else if (command === "publish") await publish(version);
  else
    throw new Error(
      "Usage: node scripts/release.mjs prepare VERSION | check [VERSION] | publish VERSION",
    );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
