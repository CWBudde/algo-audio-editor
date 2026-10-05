import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policyFindings } from "./license-policy.mjs";

export const inputFiles = [
  "bun.lock",
  "package.json",
  "apps/editor-web/package.json",
  "apps/desktop/package.json",
  "packages/protocol/package.json",
  "packages/kernel/go.mod",
  "packages/kernel/go.sum",
  "docs/licenses/policy.json",
  "scripts/generate-licenses.mjs",
  "scripts/license-policy.mjs",
  "scripts/licenses-go.mjs",
  "scripts/licenses-npm.mjs",
  "scripts/licenses-electron.mjs",
];
const manifestFile = "docs/licenses/dependencies.json";
const noticeFile = "apps/editor-web/public/third-party-notices.txt";

export function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function inputHashes(root) {
  return Object.fromEntries(
    await Promise.all(
      inputFiles.map(async (file) => [file, digest(await readFile(path.join(root, file)))]),
    ),
  );
}

export function renderNotices(entries) {
  const lines = [
    "Algo Audio Editor — Third-party notices",
    "",
    "License and copyright texts for runtime dependencies and distributed assets.",
    "The dependency inventory and audit limits are documented in docs/licenses/README.md.",
    "Electron installers also include licenses/LICENSE.electron.txt and",
    "licenses/LICENSES.chromium.html in their resources directory; Chromium",
    "component notices are supplied in that HTML file.",
    "",
  ];
  for (const entry of entries.filter((item) => item.scope === "runtime")) {
    lines.push(
      "=".repeat(72),
      `${entry.name} ${entry.version} (${entry.ecosystem})`,
      `License: ${entry.license || "UNKNOWN"}`,
      "",
    );
    if (!entry.texts?.length)
      lines.push("License evidence remains pending. See the audit report.", "");
    for (const text of entry.texts ?? [])
      lines.push(`--- ${text.file} ---`, text.text.trimEnd(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function validateInventory(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length ||
    !Array.isArray(manifest.findings)
  )
    throw new Error("Invalid license inventory.");
  const identities = new Set();
  const goNames = new Set();
  for (const entry of manifest.entries) {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    if (identities.has(key)) throw new Error(`Duplicate license inventory entry: ${key}`);
    identities.add(key);
    if (entry.ecosystem === "go") {
      if (goNames.has(entry.name)) throw new Error(`Multiple selected Go versions: ${entry.name}`);
      goNames.add(entry.name);
    }
    if (
      !entry.name ||
      !entry.version ||
      !["go", "npm"].includes(entry.ecosystem) ||
      !["runtime", "development"].includes(entry.scope) ||
      !Array.isArray(entry.texts)
    )
      throw new Error(`Invalid license inventory entry: ${key}`);
    for (const text of entry.texts)
      if (!text.file || typeof text.text !== "string" || text.sha256 !== digest(text.text))
        throw new Error(`Invalid license evidence digest: ${key}`);
  }
}

export function evidenceFindings(entries) {
  return entries.flatMap((entry) =>
    (entry.issues ?? []).map((message) => ({
      ecosystem: entry.ecosystem,
      name: entry.name,
      version: entry.version,
      kind: "evidence",
      message,
    })),
  );
}

// Development grants remain audited/informational unless their code or assets
// are redistributed (then the collector must classify that entry runtime).
export function releaseFindings(entries, findings) {
  return findings.filter((finding) => {
    const matches = entries.filter(
      (entry) =>
        entry.name === finding.name &&
        entry.version === finding.version &&
        (!finding.ecosystem || finding.ecosystem === entry.ecosystem),
    );
    return matches.length !== 1 || matches[0].scope === "runtime";
  });
}

export function binaryEvidenceFindings(manifest) {
  const binary = manifest.externalNotices;
  const electron = manifest.entries.find(
    (entry) => entry.ecosystem === "npm" && entry.name === "electron",
  );
  if (
    !binary ||
    !electron ||
    binary.version !== electron.version ||
    !Array.isArray(binary.artifacts) ||
    !Array.isArray(binary.components) ||
    !Array.isArray(binary.findings)
  )
    throw new Error(
      "Electron binary notice audit is missing or does not match the locked version.",
    );
  for (const artifact of binary.artifacts)
    if (
      !artifact.file ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0
    )
      throw new Error("Invalid Electron binary notice evidence.");
  for (const component of binary.components)
    if (
      !component.name ||
      !/^[a-f0-9]{64}$/.test(component.sha256) ||
      !Array.isArray(component.licenseFamilies)
    )
      throw new Error("Invalid Chromium component notice evidence.");
  // A wrapper grant or removed summary cannot clear the unresolved binary audit.
  // Approval requires implementing reviewed license selections/platform reach,
  // then regenerating with the changed collector rules and evidence.
  return binary.findings.length
    ? binary.findings
    : [
        {
          ecosystem: "npm",
          name: "electron",
          version: electron.version,
          kind: "binary-evidence",
          message:
            "Electron binary license selections and platform reachability remain unresolved.",
        },
      ];
}

export async function validateLockedInventory(root, entries) {
  const { expectedNpmIdentities } = await import("./licenses-npm.mjs");
  const actual = entries
    .filter((entry) => entry.ecosystem === "npm")
    .map((entry) => `${entry.name}@${entry.version}`)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedNpmIdentities({ root })))
    throw new Error("License inventory does not cover every exact Bun lockfile package.");
  const goMod = await readFile(path.join(root, "packages/kernel/go.mod"), "utf8");
  const selected = new Map(
    entries.filter((entry) => entry.ecosystem === "go").map((entry) => [entry.name, entry.version]),
  );
  for (const [, name, version] of goMod.matchAll(/^\s*(?:require\s+)?(\S+)\s+(v\S+)(?:\s|$)/gm))
    if (selected.get(name) !== version)
      throw new Error(`License inventory is missing declared Go dependency ${name}@${version}.`);
  const toolchain = goMod.match(/^toolchain\s+(\S+)/m)?.[1];
  if (!toolchain || selected.get("Go runtime and standard library") !== toolchain)
    throw new Error("License inventory does not cover the pinned Go toolchain.");
}

export async function run({ root, check = false, strict = false }) {
  const inputs = await inputHashes(root);
  const policy = JSON.parse(await readFile(path.join(root, "docs/licenses/policy.json"), "utf8"));
  let manifest;
  if (check) {
    manifest = JSON.parse(await readFile(path.join(root, manifestFile), "utf8"));
    validateInventory(manifest);
    if (JSON.stringify(manifest.inputs) !== JSON.stringify(inputs))
      throw new Error(
        "Dependency inputs or license policy changed; run just licenses and review the audit.",
      );
    if ((await readFile(path.join(root, noticeFile), "utf8")) !== renderNotices(manifest.entries))
      throw new Error("Third-party notices are stale; run just licenses.");
    await validateLockedInventory(root, manifest.entries);
  } else {
    const { collectGoLicenses } = await import("./licenses-go.mjs");
    const { collectNpmLicenses } = await import("./licenses-npm.mjs");
    const { collectElectronLicenses } = await import("./licenses-electron.mjs");
    const [go, npm, externalNotices] = await Promise.all([
      collectGoLicenses({ root }),
      collectNpmLicenses({ root }),
      collectElectronLicenses({ root }),
    ]);
    const entries = [
      ...(Array.isArray(go) ? go : go.entries),
      ...(Array.isArray(npm) ? npm : npm.entries),
    ]
      .map((entry) => ({
        ...entry,
        texts: entry.texts.map((text) => ({ ...text, sha256: digest(text.text) })),
      }))
      .sort((a, b) =>
        `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(
          `${b.ecosystem}:${b.name}@${b.version}`,
          "en",
        ),
      );
    manifest = {
      schemaVersion: 1,
      inputs,
      entries,
      findings: [...(go.findings ?? []), ...(npm.findings ?? [])],
      externalNotices,
    };
    validateInventory(manifest);
    await validateLockedInventory(root, manifest.entries);
    if (JSON.stringify(inputs) !== JSON.stringify(await inputHashes(root)))
      throw new Error("Audit changed dependency inputs; restore them and regenerate.");
    await mkdir(path.join(root, "docs/licenses"), { recursive: true });
    await writeFile(path.join(root, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(root, noticeFile), renderNotices(entries));
  }
  const findings = [
    ...manifest.findings,
    ...evidenceFindings(manifest.entries),
    ...policyFindings(manifest.entries, policy),
    ...binaryEvidenceFindings(manifest),
  ];
  const blockers = releaseFindings(manifest.entries, findings);
  const summary = {
    dependencies: manifest.entries.length,
    runtime: manifest.entries.filter((entry) => entry.scope === "runtime").length,
    development: manifest.entries.filter((entry) => entry.scope === "development").length,
    releaseBlockers: blockers.length,
    findings,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (strict && blockers.length)
    throw new Error("Release license audit has unresolved runtime findings.");
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--check", "--strict"].includes(arg)))
    throw new Error("Unknown license audit option.");
  await run({
    root: fileURLToPath(new URL("../", import.meta.url)),
    check: args.includes("--check"),
    strict: args.includes("--strict"),
  });
}
