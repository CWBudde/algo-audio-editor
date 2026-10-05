import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const legalFile = /^(?:licen[sc]e|copying|notice|copyright|authors|patents)(?:[._-].*)?$/i;
const sourceFile = /\.(?:go|s|h|c|cc|js)$/i;

// `go list -json` emits adjacent JSON values rather than an array. Splitting on
// lines or braces breaks escaped source strings and nested Module objects.
export function parseGoJSONStream(input) {
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      if (depth === 0) throw new Error("Unexpected string in Go JSON stream");
      quoted = true;
    } else if (char === "{" || char === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" || char === "]") {
      if (--depth < 0) throw new Error("Malformed Go JSON stream");
      if (depth === 0) {
        values.push(JSON.parse(input.slice(start, i + 1)));
        start = -1;
      }
    } else if (depth === 0 && !/\s/.test(char)) {
      throw new Error("Unexpected text in Go JSON stream");
    }
  }
  if (depth !== 0 || quoted) throw new Error("Incomplete Go JSON stream");
  return values;
}

export function identifyGoLicense(text) {
  if (/MCP project is undergoing a licensing transition/.test(text)) {
    // The final CC-BY clause covers documentation, not the imported Go code.
    return "Apache-2.0 AND MIT";
  }
  if (/This is free and unencumbered software released into the public domain/.test(text))
    return "Unlicense";
  if (/Apache License[\s\S]*Version 2\.0/.test(text)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/.test(text)) return "MIT";
  if (/Redistribution and use in source and binary forms/.test(text)) {
    if (
      /1\.\s+Redistributions of source code/.test(text.replaceAll(/\/\/\s*/g, "")) &&
      !/2\.\s+Redistributions/.test(text.replaceAll(/\/\/\s*/g, ""))
    )
      return "BSD-1-Clause";
    return /Neither the name|names of its contributors/.test(text)
      ? "BSD-3-Clause"
      : "BSD-2-Clause";
  }
  return "UNKNOWN";
}

// Keep actual source notices, including embedded third-party permission blocks.
// Repeated identical headers are deduplicated, with the first sorted source
// location retained. This is not a semantic Go parser or a legal approval.
export function sourceNotices(text) {
  const comments = text.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*(?:\n|$))+/gm) ?? [];
  return comments.filter((comment) =>
    /copyright\s+(?:\(c\)\s*)?\d|copyright\s+\(c\)|©\s*\d|SPDX-License-Identifier:|permission (?:is hereby|to use)|redistribution and use in source/i.test(
      comment,
    ),
  );
}

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(directory);
  return files;
}

function go(moduleRoot, args, environment = {}) {
  return execFileSync("go", args, {
    cwd: moduleRoot,
    env: { ...process.env, GOWORK: "off", GOFLAGS: "", CGO_ENABLED: "0", ...environment },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// A cheap declared-identity guard for the combined audit's check mode. The
// seven additional selected graph modules come from actual Go collection.
// Neither this guard nor input hashes re-read license evidence; regenerate it.
export async function expectedGoIdentities({ root }) {
  const contents = await readFile(path.join(root, "packages/kernel/go.mod"), "utf8");
  if (/^replace\s/m.test(contents))
    throw new Error("License audit does not accept replaced Go modules");
  const modules = [
    ...contents.matchAll(/^\s*(?:require\s+)?([^\s()]+)\s+(v\S+)\s*(?:\/\/.*)?$/gm),
  ].map(([, name, version]) => ({ ecosystem: "go", name, version }));
  const version = contents.match(/^toolchain\s+(go\S+)$/m)?.[1];
  if (!version) throw new Error("Go license audit requires a pinned toolchain directive");
  return [...modules, { ecosystem: "go", name: "Go runtime and standard library", version }].sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  );
}

async function evidence(directory, files, compiledFiles, runtime) {
  const texts = [];
  const seen = new Set();
  const codeDirectories = [...compiledFiles].map((file) => path.dirname(file));
  for (const filename of files) {
    const relative = path.relative(directory, filename).replaceAll(path.sep, "/");
    const isLegal = legalFile.test(path.basename(filename));
    const coversCode =
      path.dirname(filename) === directory ||
      codeDirectories.some(
        (dir) =>
          dir === path.dirname(filename) || dir.startsWith(`${path.dirname(filename)}${path.sep}`),
      );
    if (isLegal && (!runtime || coversCode)) {
      texts.push({ file: relative, text: await readFile(filename, "utf8") });
    } else if (sourceFile.test(filename) && (!runtime || compiledFiles.has(filename))) {
      for (const notice of sourceNotices(await readFile(filename, "utf8"))) {
        if (!seen.has(notice)) {
          seen.add(notice);
          texts.push({ file: `${relative} (source notice)`, text: notice });
        }
      }
    }
  }
  return texts.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

export async function collectGoLicenses({ root }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aae-go-licenses-"));
  try {
    const modfile = path.join(temporary, "go.mod");
    await copyFile(path.join(root, "packages/kernel/go.mod"), modfile);
    await copyFile(path.join(root, "packages/kernel/go.sum"), path.join(temporary, "go.sum"));
    return await collectGoSources({ root, modfile });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function collectGoSources({ root, modfile }) {
  const moduleRoot = path.join(root, "packages/kernel");
  const pinned = (await expectedGoIdentities({ root })).find(
    (entry) => entry.name === "Go runtime and standard library",
  ).version;
  const run = (args, env = {}) =>
    go(moduleRoot, args, { GOFLAGS: `-modfile=${modfile}`, GOTOOLCHAIN: pinned, ...env });
  // Graph-only dependency sums may deliberately be absent after `go mod tidy`.
  // Complete them in the temporary files so cold-cache collection also works.
  run(["mod", "download", "all"]);
  const modules = parseGoJSONStream(run(["list", "-mod=readonly", "-m", "-json", "all"]));
  const environment = JSON.parse(run(["env", "-json", "GOROOT", "GOVERSION"]));
  const reachable = new Map();
  const standardFiles = new Set();
  const targets = [
    ["linux", "amd64"],
    ["linux", "arm64"],
    ["darwin", "amd64"],
    ["darwin", "arm64"],
    ["windows", "amd64"],
    ["windows", "arm64"],
    ["js", "wasm"],
  ];
  for (const [GOOS, GOARCH] of targets) {
    const commands = GOOS === "js" ? ["./cmd/kernel"] : ["./cmd/aae", "./cmd/aae-mcp"];
    const packages = parseGoJSONStream(
      run(["list", "-mod=readonly", "-deps", "-json", ...commands], { GOOS, GOARCH }),
    );
    for (const pkg of packages) {
      const compiled = [
        "GoFiles",
        "CgoFiles",
        "CFiles",
        "CXXFiles",
        "HFiles",
        "SFiles",
        "EmbedFiles",
      ]
        .flatMap((key) => pkg[key] ?? [])
        .map((file) => path.join(pkg.Dir, file));
      if (pkg.Standard) compiled.forEach((file) => standardFiles.add(file));
      else if (pkg.Module && !pkg.Module.Main) {
        const files = reachable.get(pkg.Module.Path) ?? new Set();
        compiled.forEach((file) => files.add(file));
        reachable.set(pkg.Module.Path, files);
      }
    }
  }
  const result = [];
  for (const original of modules.filter((module) => !module.Main)) {
    if (original.Replace)
      throw new Error(`License audit does not accept replaced Go module ${original.Path}`);
    const module = {
      ...original,
      ...JSON.parse(run(["mod", "download", "-json", `${original.Path}@${original.Version}`])),
    };
    if (!module.Dir || module.Error)
      throw new Error(`Cannot read exact module sources: ${original.Path}@${original.Version}`);
    const runtime = reachable.has(module.Path);
    const files = await filesUnder(module.Dir);
    const texts = await evidence(
      module.Dir,
      files,
      reachable.get(module.Path) ?? new Set(),
      runtime,
    );
    const mainText = texts.find((text) => /^(?:LICENSE|LICENCE|COPYING)(?:\.|$)/i.test(text.file));
    const issues = [];
    let license = mainText ? identifyGoLicense(mainText.text) : "UNKNOWN";
    if (!mainText) {
      issues.push("No complete root license text in the exact pinned module source.");
      const readme = files.find((file) => path.relative(module.Dir, file) === "README.md");
      if (readme) {
        const section = (await readFile(readme, "utf8")).match(
          /^## License\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m,
        );
        if (section) {
          texts.push({ file: "README.md (license declaration)", text: section[0] });
          if (/^MIT\s*$/m.test(section[1])) license = "MIT";
        }
      }
    }
    if (
      module.Path === "github.com/cwbudde/flac" &&
      license === "Unlicense" &&
      texts.some(({ text }) => /BSD-style/.test(text)) &&
      !texts.some(({ text }) => /Redistribution and use in source and binary forms/.test(text))
    ) {
      issues.push(
        "Embedded crc8/crc16 source notices reference BSD terms, but the module's sole LICENSE supplies Unlicense; retain notices and resolve upstream license text.",
      );
    }
    result.push({
      ecosystem: "go",
      name: module.Path,
      version: module.Version,
      license,
      scope: runtime ? "runtime" : "development",
      texts,
      source: `https://${module.Path}`,
      ...(module.Sum ? { integrity: module.Sum } : {}),
      ...(issues.length ? { issues } : {}),
    });
  }
  run(["mod", "verify"]);
  const goroot = environment.GOROOT;
  const wasmExec = path.join(goroot, "lib/wasm/wasm_exec.js");
  standardFiles.add(wasmExec);
  const goFiles = (await filesUnder(path.join(goroot, "src"))).filter(
    (file) => standardFiles.has(file) || legalFile.test(path.basename(file)),
  );
  goFiles.push(path.join(goroot, "LICENSE"), path.join(goroot, "PATENTS"), wasmExec);
  const texts = await evidence(goroot, goFiles, standardFiles, true);
  // Keep the bridge's own evidence location even when its generic BSD header
  // duplicates a standard-library source notice.
  for (const notice of sourceNotices(await readFile(wasmExec, "utf8"))) {
    texts.push({ file: "lib/wasm/wasm_exec.js (source notice)", text: notice });
  }
  texts.sort((a, b) => a.file.localeCompare(b.file, "en"));
  const hasSun = texts.some(({ text }) => /Developed at SunPro/.test(text));
  const hasCephes = texts.some(({ text }) => /Cephes Math Library/.test(text));
  const licenses = new Set(["BSD-3-Clause"]);
  for (const { text } of texts.filter(({ file }) => file.endsWith("(source notice)"))) {
    const identified = identifyGoLicense(text);
    if (identified !== "UNKNOWN") licenses.add(identified);
  }
  if (hasSun) licenses.add("SunPro");
  if (hasCephes) licenses.add("LicenseRef-Cephes");
  result.push({
    ecosystem: "go",
    name: "Go runtime and standard library",
    version: environment.GOVERSION,
    license: [...licenses].sort().join(" AND "),
    scope: "runtime",
    texts,
    source: `https://go.dev/dl/#${environment.GOVERSION}`,
  });
  return result.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
