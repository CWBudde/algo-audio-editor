import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bun's text lockfile is JSON with comments and trailing commas. Strip only
// outside strings; URLs and escaped quotes must survive without evaluating code.
export function parseBunLock(text) {
  let clean = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      clean += c;
      if (c === "\\") clean += text[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      clean += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated Bun lockfile comment");
      clean += " ";
      i = end + 1;
    } else clean += c;
  }
  let json = "";
  quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      json += c;
      if (c === "\\") json += clean[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      json += c;
    } else if (c === ",") {
      let next = i + 1;
      while (next < clean.length && /\s/.test(clean[next])) next++;
      if (clean[next] !== "}" && clean[next] !== "]") json += c;
    } else json += c;
  }
  const lock = JSON.parse(json);
  if (lock.lockfileVersion !== 2 || !lock.packages || !lock.workspaces)
    throw new Error("Unsupported Bun lockfile; expected version 2 packages/workspaces");
  return lock;
}

export function lockedIdentity(record) {
  const descriptor = record?.[0];
  if (typeof descriptor !== "string") throw new Error("Malformed Bun package record");
  const split = descriptor.lastIndexOf("@");
  if (split <= 0) throw new Error(`Unsupported Bun package descriptor: ${descriptor}`);
  return { name: descriptor.slice(0, split), version: descriptor.slice(split + 1) };
}

export function expectedNpmIdentities({ root }) {
  const lock = parseBunLock(readFileSync(path.join(root, "bun.lock"), "utf8"));
  return [
    ...new Set(
      Object.values(lock.packages)
        .map(lockedIdentity)
        .filter((item) => !item.version.startsWith("workspace:"))
        .map((item) => `${item.name}@${item.version}`),
    ),
  ].sort();
}

export function resolveLockedDependency(lock, parent, name) {
  let ancestor = parent;
  while (ancestor) {
    const candidate = `${ancestor}/${name}`;
    if (lock.packages[candidate]) return candidate;
    const parentName = lockedIdentity(lock.packages[ancestor]).name;
    ancestor = ancestor === parentName ? "" : ancestor.slice(0, -parentName.length - 1);
  }
  return lock.packages[name] ? name : null;
}

function manifest(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

function licenseName(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (typeof pkg.license?.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((item) => item.type).join(" OR ");
  return "UNKNOWN";
}

function textsIn(directory) {
  const texts = [];
  function walk(relative, depth) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const file = path.posix.join(relative, entry.name);
      // Electron binary attribution has its own installer collector. Never
      // follow dependency symlinks or include executable/binary payloads.
      if (
        entry.isDirectory() &&
        depth < 4 &&
        !["node_modules", ".git"].includes(entry.name) &&
        !(entry.name === "dist" && manifest(directory).name === "electron")
      )
        walk(file, depth + 1);
      if (
        entry.isFile() &&
        /^(?:licen[cs]e|copying|copyright|notice|third[-_ ]party[-_ ](?:notice|licen[cs]e))s?(?:[._-].*)?$/i.test(
          entry.name,
        )
      ) {
        const text = readFileSync(path.join(directory, file), "utf8");
        if (text.trim() && !text.includes("\u0000"))
          texts.push({ file, text, sha256: createHash("sha256").update(text).digest("hex") });
      }
    }
  }
  walk("", 0);
  // A few older packages distribute the grant in README instead of a LICENSE.
  if (!texts.length) {
    for (const name of readdirSync(directory)
      .filter((name) => /^readme(?:\..*)?$/i.test(name))
      .sort()) {
      const readme = readFileSync(path.join(directory, name), "utf8");
      const section = readme.match(
        /^#{1,3}\s+(?:license|copyright)[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im,
      );
      // SPDX labels/links alone are insufficient license evidence.
      if (
        section &&
        /permission is hereby granted|redistribution and use|permission to use, copy/i.test(
          section[0],
        ) &&
        section[0].length > 500
      ) {
        const text = section[0];
        texts.push({
          file: `${name}#license`,
          text,
          sha256: createHash("sha256").update(text).digest("hex"),
        });
      }
    }
  }
  return texts;
}

function packageDirectories(root) {
  const store = path.join(root, "node_modules", ".bun");
  const result = new Map();
  if (!existsSync(store)) return result;
  for (const item of readdirSync(store).sort()) {
    if (item === "node_modules") continue;
    const split = item.lastIndexOf("@");
    if (split < 1) continue;
    const name = item.slice(0, split).replaceAll("+", "/");
    const directory = path.join(store, item, "node_modules", name);
    if (!existsSync(path.join(directory, "package.json"))) continue;
    const pkg = manifest(directory);
    const key = `${pkg.name}@${pkg.version}`;
    if (!result.has(key)) result.set(key, directory);
  }
  return result;
}

async function registryPackage(name, version, integrity) {
  if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity ?? ""))
    throw new Error("Missing supported lockfile tarball integrity");
  const url = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = integrity.split("-");
  if (createHash(algorithm).update(bytes).digest("base64") !== expected)
    throw new Error("Registry tarball failed Bun lockfile integrity verification");
  const temporary = mkdtempSync(path.join(tmpdir(), "aae-license-"));
  try {
    const archive = path.join(temporary, "package.tgz");
    writeFileSync(archive, bytes);
    // No install scripts execute. Reject traversal before extracting a verified
    // registry archive, and let tar refuse absolute paths/symlink traversals.
    const files = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .trim()
      .split("\n");
    const prefix = files[0]?.split("/")[0];
    if (
      !prefix ||
      files.some(
        (file) =>
          file.startsWith("/") || file.split("/")[0] !== prefix || file.split("/").includes(".."),
      )
    )
      throw new Error("Unsafe registry archive path");
    execFileSync("tar", [
      "-xzf",
      archive,
      "--no-same-owner",
      "--no-same-permissions",
      "--strip-components=1",
      "-C",
      temporary,
    ]);
    const directory = temporary;
    const pkg = manifest(directory);
    if (pkg.name !== name || pkg.version !== version)
      throw new Error("Registry manifest does not match lockfile");
    return { pkg, texts: textsIn(directory), source: { kind: "registry-tarball", url, integrity } };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function releaseSourceLicense(name, version, integrity) {
  const metadataUrl = `https://registry.npmjs.org/${name}/${version}`;
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return [];
  const release = await response.json();
  // Some published archives omit the grant. Only use upstream evidence when
  // this exact integrity-verified npm release records an immutable Git commit.
  if (
    release.name !== name ||
    release.version !== version ||
    release.dist?.integrity !== integrity ||
    !/^[a-f0-9]{40}$/.test(release.gitHead ?? "")
  )
    return [];
  const repository =
    typeof release.repository === "string" ? release.repository : release.repository?.url;
  const match = repository?.match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/);
  if (!match) return [];
  const subdirectory = release.repository?.directory;
  const prefixes =
    subdirectory && !subdirectory.split("/").includes("..") ? [`${subdirectory}/`, ""] : [""];
  for (const prefix of prefixes) {
    for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) {
      const url = `https://raw.githubusercontent.com/${match[1]}/${release.gitHead}/${prefix}${file}`;
      const source = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!source.ok) continue;
      const text = await source.text();
      if (!text.trim()) continue;
      return [
        {
          file: `upstream/${prefix}${file}`,
          text,
          sha256: createHash("sha256").update(text).digest("hex"),
          source: { url, revision: release.gitHead, releaseMetadata: metadataUrl },
        },
      ];
    }
  }
  return [];
}

export async function collectNpmLicenses({ root, fetchMissing = true }) {
  const lock = parseBunLock(readFileSync(path.join(root, "bun.lock"), "utf8"));
  const directories = packageDirectories(root);
  const findings = [];
  const runtime = new Set();
  const queue = [];
  const add = (key, traverse = true) => {
    if (!key || runtime.has(key)) return;
    runtime.add(key);
    if (traverse) queue.push(key);
  };
  for (const [workspace, locked] of Object.entries(lock.workspaces)) {
    const pkg = manifest(path.join(root, workspace));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (
        JSON.stringify(Object.entries(pkg[field] ?? {}).sort()) !==
        JSON.stringify(Object.entries(locked[field] ?? {}).sort())
      )
        throw new Error(`${workspace || "."}: ${field} differ between manifest and bun.lock`);
      for (const name of Object.keys(pkg[field] ?? {})) {
        const workspaceKey = lock.packages[pkg.name] ? pkg.name : "";
        const key = resolveLockedDependency(lock, workspaceKey, name);
        if (!key) throw new Error(`Workspace dependency absent from lock: ${name}`);
        const identity = lockedIdentity(lock.packages[key]);
        if (identity.version.startsWith("workspace:")) continue;
        const installed = path.join(root, workspace, "node_modules", name);
        if (existsSync(path.join(installed, "package.json"))) {
          const actual = manifest(installed);
          if (actual.name !== identity.name || actual.version !== identity.version)
            throw new Error(
              `${workspace}: installed ${name}@${actual.version} differs from locked ${identity.version}`,
            );
        }
        if (field !== "devDependencies") add(key, name !== "shadcn");
        // These development declarations also redistribute code/assets.
        if (name === "electron" || (workspace === "apps/editor-web" && name === "tailwindcss"))
          add(key, false);
      }
    }
  }
  while (queue.length) {
    const key = queue.shift();
    const metadata = lock.packages[key][2] ?? {};
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(metadata[field] ?? {})) {
        if (field === "peerDependencies" && (metadata.optionalPeers ?? []).includes(name)) continue;
        const child = resolveLockedDependency(lock, key, name);
        if (!child) {
          if (field !== "optionalDependencies")
            findings.push({
              kind: "unresolved-runtime-dependency",
              name,
              message: `${key} has no locked ${field} resolution for ${name}`,
            });
          continue;
        }
        if (!lockedIdentity(lock.packages[child]).version.startsWith("workspace:")) add(child);
      }
    }
  }
  const grouped = new Map();
  for (const [key, record] of Object.entries(lock.packages)) {
    const { name, version } = lockedIdentity(record);
    if (version.startsWith("workspace:")) continue;
    if (!/^\d/.test(version))
      throw new Error(`Unsupported non-registry package ${name}@${version}`);
    const id = `${name}@${version}`;
    const group = grouped.get(id) ?? { name, version, record, lockKeys: [], runtime: false };
    group.lockKeys.push(key);
    group.runtime ||= runtime.has(key);
    grouped.set(id, group);
  }
  const entries = [];
  // Four bounded workers avoid a long serial registry crawl on other platforms.
  const pending = [...grouped.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"),
  );
  async function collect() {
    while (pending.length) {
      const item = pending.shift();
      const { name, version } = item;
      const directory = directories.get(`${name}@${version}`);
      let evidence = directory
        ? {
            pkg: manifest(directory),
            texts: textsIn(directory),
            source: { kind: "installed-package", integrity: item.record[3] },
          }
        : null;
      if ((!evidence || !evidence.texts.length) && fetchMissing) {
        try {
          evidence = await registryPackage(name, version, item.record[3]);
        } catch (error) {
          findings.push({ kind: "source-unavailable", name, version, message: error.message });
        }
      }
      if (evidence && !evidence.texts.length && fetchMissing) {
        try {
          evidence.texts = await releaseSourceLicense(name, version, item.record[3]);
        } catch (error) {
          findings.push({
            kind: "source-unavailable",
            name,
            version,
            message: `Release source: ${error.message}`,
          });
        }
      }
      const entry = {
        ecosystem: "npm",
        name,
        version,
        license: evidence ? licenseName(evidence.pkg) : "UNKNOWN",
        scope: item.runtime ? "runtime" : "development",
        texts: evidence?.texts ?? [],
        source: evidence?.source ?? { kind: "unavailable", integrity: item.record[3] },
        lockKeys: item.lockKeys.sort(),
        installed: Boolean(directory),
      };
      if (name.startsWith("@fontsource/") || name.startsWith("@fontsource-variable/"))
        entry.asset = true;
      const restrictions = item.record[2] ?? {};
      if (restrictions.os || restrictions.cpu)
        entry.platform = {
          ...(restrictions.os && { os: restrictions.os }),
          ...(restrictions.cpu && { cpu: restrictions.cpu }),
        };
      if (!entry.texts.length || entry.license === "UNKNOWN")
        findings.push({
          kind:
            entry.scope === "runtime" ? "missing-runtime-license" : "missing-development-license",
          name,
          version,
          message: `${entry.scope}: ${!entry.texts.length ? "no full license text" : "manifest license unspecified"}${!directory ? "; not installed on audit host" : ""}`,
        });
      entries.push(entry);
    }
  }
  await Promise.all(Array.from({ length: 4 }, collect));
  entries.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  findings.sort((a, b) =>
    `${a.name ?? ""}@${a.version ?? ""}/${a.kind}`.localeCompare(
      `${b.name ?? ""}@${b.version ?? ""}/${b.kind}`,
      "en",
    ),
  );
  return { entries, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collectNpmLicenses({
    root: path.resolve(process.argv[2] ?? "."),
    fetchMissing: !process.argv.includes("--offline"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (
    result.findings.some(
      (item) =>
        item.kind === "missing-runtime-license" || item.kind === "unresolved-runtime-dependency",
    )
  )
    process.exitCode = 1;
}
