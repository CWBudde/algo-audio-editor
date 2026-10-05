import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectNpmLicenses,
  expectedNpmIdentities,
  parseBunLock,
  resolveLockedDependency,
} from "./licenses-npm.mjs";

function fixture(t, packages, dependencies = {}, devDependencies = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "aae-npm-license-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = { name: "test", dependencies, devDependencies };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  const lock = { lockfileVersion: 2, workspaces: { "": pkg }, packages };
  writeFileSync(path.join(root, "bun.lock"), JSON.stringify(lock));
  function install(
    name,
    version,
    license = "MIT",
    text = "Copyright 2026 The Authors\nPermission is hereby granted to use this software.\n",
    link = true,
  ) {
    const directory = path.join(
      root,
      "node_modules",
      ".bun",
      `${name.replaceAll("/", "+")}@${version}`,
      "node_modules",
      name,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version, license }));
    if (text !== null) writeFileSync(path.join(directory, "LICENSE"), text);
    if (link) {
      const target = path.join(root, "node_modules", name);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(directory, target, "dir");
    }
    return directory;
  }
  return { root, lock, install };
}

const record = (name, version, metadata = {}) => [
  `${name}@${version}`,
  "",
  metadata,
  "sha512-Zml4dHVyZQ==",
];

test("JSONC preserves URLs, comment-shaped string contents and escaped quotes", () => {
  const lock = parseBunLock(`{
    // A commented JSONC lock, with trailing commas before comments.
    "lockfileVersion": 2,
    "workspaces": {},
    "packages": {"sample": ["sample@1.0.0", "https://example.org/*file*/", {"description":"quote: \\\" // text"},], /* comment */},
  }`);
  assert.equal(lock.packages.sample[1], "https://example.org/*file*/");
  assert.equal(lock.packages.sample[2].description, 'quote: " // text');
  assert.throws(
    () => parseBunLock('{"lockfileVersion":1,"packages":{},"workspaces":{}}'),
    /Unsupported/,
  );
  assert.throws(() => parseBunLock("{/* unterminated"), /Unterminated/);
});

test("scoped and nested Bun resolutions prefer the nearest lock ancestor", () => {
  const lock = {
    packages: {
      "@scope/parent": record("@scope/parent", "1.0.0"),
      "@scope/parent/@other/child": record("@other/child", "1.0.0"),
      "@scope/parent/leaf": record("leaf", "2.0.0"),
      leaf: record("leaf", "3.0.0"),
    },
  };
  assert.equal(
    resolveLockedDependency(lock, "@scope/parent/@other/child", "leaf"),
    "@scope/parent/leaf",
  );
  assert.equal(
    resolveLockedDependency(lock, "@scope/parent", "@other/child"),
    "@scope/parent/@other/child",
  );
  assert.equal(resolveLockedDependency(lock, "@scope/parent", "absent"), null);
});

test("runtime closure includes updater transitives/peers, while CSS-only shadcn keeps CLI dependencies development", async (t) => {
  const packages = {
    updater: record("updater", "1.0.0", {
      dependencies: { shared: "1.0.0" },
      peerDependencies: { peer: "1.0.0" },
    }),
    shared: record("shared", "1.0.0"),
    peer: record("peer", "1.0.0"),
    shadcn: record("shadcn", "1.0.0", { dependencies: { tool: "1.0.0" } }),
    tool: record("tool", "1.0.0"),
    electron: record("electron", "1.0.0", { dependencies: { downloader: "1.0.0" } }),
    downloader: record("downloader", "1.0.0"),
  };
  const f = fixture(t, packages, { updater: "1.0.0", shadcn: "1.0.0" }, { electron: "1.0.0" });
  for (const name of Object.keys(packages)) f.install(name, "1.0.0");
  const first = await collectNpmLicenses({ root: f.root, fetchMissing: false });
  assert.deepEqual(first.findings, []);
  assert.deepEqual(
    first.entries.filter((item) => item.scope === "runtime").map((item) => item.name),
    ["electron", "peer", "shadcn", "shared", "updater"],
  );
  assert.deepEqual(first, await collectNpmLicenses({ root: f.root, fetchMissing: false }));
  const shared = first.entries.find((item) => item.name === "shared");
  assert.match(shared.texts[0].text, /Copyright 2026 The Authors/);
  assert.match(shared.texts[0].sha256, /^[a-f0-9]{64}$/);
});

test("all exact versions including uninstalled platform optionals are inventoried, duplicates collapse", async (t) => {
  const packages = {
    package: record("package", "1.0.0"),
    "tool/package": record("package", "1.0.0"),
    "other/package": record("package", "2.0.0"),
    native: record("native", "1.0.0", { os: "darwin", cpu: "arm64" }),
  };
  const f = fixture(t, packages, { package: "1.0.0" });
  f.install("package", "1.0.0");
  f.install("package", "2.0.0", "MIT", undefined, false);
  const result = await collectNpmLicenses({ root: f.root, fetchMissing: false });
  assert.deepEqual(expectedNpmIdentities({ root: f.root }), [
    "native@1.0.0",
    "package@1.0.0",
    "package@2.0.0",
  ]);
  assert.equal(result.entries.length, 3);
  assert.deepEqual(
    result.entries.find((item) => item.name === "package" && item.version === "1.0.0").lockKeys,
    ["package", "tool/package"],
  );
  const native = result.entries.find((item) => item.name === "native");
  assert.equal(native.installed, false);
  assert.equal(native.source.kind, "unavailable");
  assert.deepEqual(native.platform, { os: "darwin", cpu: "arm64" });
  assert.equal(result.findings[0].kind, "missing-development-license");
});

test("missing runtime grant and unresolved dependency fail closed without fabricating SPDX text", async (t) => {
  const f = fixture(
    t,
    { app: record("app", "1.0.0", { dependencies: { absent: "1.0.0" } }) },
    { app: "1.0.0" },
  );
  const directory = f.install("app", "1.0.0", "MIT", null);
  writeFileSync(
    path.join(directory, "README.md"),
    "# License\nMIT; see https://opensource.org/license/mit\n",
  );
  const result = await collectNpmLicenses({ root: f.root, fetchMissing: false });
  assert.deepEqual(result.entries[0].texts, []);
  assert.deepEqual(result.findings.map((item) => item.kind).sort(), [
    "missing-runtime-license",
    "unresolved-runtime-dependency",
  ]);
});

test("source collection rejects stale installed workspace versions and manifest/lock drift", async (t) => {
  const f = fixture(t, { app: record("app", "1.0.0") }, { app: "1.0.0" });
  f.install("app", "2.0.0");
  await assert.rejects(
    collectNpmLicenses({ root: f.root, fetchMissing: false }),
    /installed app@2.0.0 differs/,
  );
  writeFileSync(
    path.join(f.root, "package.json"),
    JSON.stringify({ dependencies: { app: "2.0.0" }, devDependencies: {} }),
  );
  await assert.rejects(
    collectNpmLicenses({ root: f.root, fetchMissing: false }),
    /differ between manifest and bun.lock/,
  );
});

test("full nested NOTICE and COPYING texts survive the audit", async (t) => {
  const f = fixture(t, { app: record("app", "1.0.0") }, { app: "1.0.0" });
  const directory = f.install("app", "1.0.0");
  mkdirSync(path.join(directory, "dist"));
  writeFileSync(
    path.join(directory, "dist", "NOTICE.txt"),
    "Upstream copyright notice, retained verbatim.\n",
  );
  writeFileSync(
    path.join(directory, "COPYING"),
    "Second complete grant supplied in the package.\n",
  );
  const result = await collectNpmLicenses({ root: f.root, fetchMissing: false });
  assert.deepEqual(
    result.entries[0].texts.map((item) => item.file),
    ["COPYING", "dist/NOTICE.txt", "LICENSE"],
  );
});
