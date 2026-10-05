import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMathReach, inspectWasm, parseDumpDependencies } from "./go-math-reach-analysis.mjs";
import { parseGoJSONStream } from "./licenses-go.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const targets = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
  ["windows", "arm64"],
  ["js", "wasm"],
];
const wasmFlags = [
  "-Oz",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
];

export function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--output" && args[1] && !args[1].startsWith("-"))
    return { output: args[1] };
  throw new Error("Usage: node scripts/go-math-reach.mjs [--output report.json]");
}

export function pinnedToolchain(text) {
  const value = text.match(/^toolchain (go\d+\.\d+\.\d+)$/m)?.[1];
  if (!value) throw new Error("A pinned release toolchain directive is required");
  if (/^replace\s/m.test(text))
    throw new Error("Replaced modules are outside this diagnostic's scope");
  return value;
}

export function diagnosticEnvironment(original, toolchain, temporary) {
  const result = {
    ...original,
    GOWORK: "off",
    GOTOOLCHAIN: toolchain,
    GOENV: "off",
    GOFLAGS: "",
    CGO_ENABLED: "0",
    GOEXPERIMENT: "",
    GOFIPS140: "off",
    GOAMD64: "v1",
    GOARM64: "v8.0",
    GOTMPDIR: temporary,
  };
  delete result.GOROOT;
  delete result.GOGCCFLAGS;
  delete result.GOOS;
  delete result.GOARCH;
  return result;
}

// Snapshot every regular module file, including embeds and untracked source.
// Generated binary/coverage outputs cannot affect this Go build and are excluded.
// Reject links rather than following source outside the recorded snapshot.
export function snapshotKernel(source, destination) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const local = relative(source, path).replaceAll("\\", "/");
      if (local === "bin" || local === "coverage.out" || local === ".git") continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Kernel source symlink is unsupported: ${local}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) {
        const data = readFileSync(path);
        files.push({ file: local, bytes: data.length, sha256: sha256(data) });
        if (destination) {
          const output = join(destination, local);
          mkdirSync(dirname(output), { recursive: true });
          copyFileSync(path, output);
        }
      } else throw new Error(`Kernel source must be regular: ${local}`);
    }
  }
  visit(source);
  return { files, sha256: sha256(JSON.stringify(files)) };
}

export function compactWasmInspection(inspection, reach) {
  const mathNames = inspection.functionNames.filter(({ name }) => /^math(?:_cmplx)?\./.test(name));
  return {
    ...inspection,
    functionNameCount: inspection.functionNames.length,
    functionNames: mathNames.map((entry) => ({
      ...entry,
      linkerMatches: reach.retainedMathSymbols
        .filter(({ symbol }) => symbol.replace(/[^\w.]/g, "_") === entry.name)
        .map(({ symbol, mapping, sources }) => ({ symbol, mapping, sources })),
      scope:
        "Exact Go-sanitized name correspondence; instructions, inline provenance and optimizer transformations remain unattributed.",
    })),
  };
}

export function verifiedOptimizedNames(finalInspection, namedInspection, reach) {
  const nonCustomSectionsMatch =
    finalInspection.nonCustomSha256 === namedInspection.nonCustomSha256;
  if (nonCustomSectionsMatch)
    return {
      nonCustomSectionsMatch,
      mappingAccepted: true,
      inspection: compactWasmInspection(namedInspection, reach),
    };
  const { functionNames, ...withoutNames } = namedInspection;
  return {
    nonCustomSectionsMatch,
    mappingAccepted: false,
    inspection: { ...withoutNames, functionNameCount: functionNames.length },
    limitation:
      "Named optimization differs from actual final non-custom bytes. Companion names are withheld from final source attribution; Binaryen naming/ordering or transformations require further review.",
  };
}

export function runDiagnostic(options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "aae-go-math-reach-"));
  const kernelRoot = join(root, "packages/kernel");
  const snapshot = join(temporary, "kernel");
  const started = new Date().toISOString();
  let report;
  try {
    const source = snapshotKernel(kernelRoot, snapshot);
    const toolchain = pinnedToolchain(readFileSync(join(snapshot, "go.mod"), "utf8"));
    const env = diagnosticEnvironment(process.env, toolchain, temporary);
    function run(command, args, extra = {}) {
      const began = performance.now();
      const result = spawnSync(command, args, {
        cwd: snapshot,
        env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 128 * 1024 * 1024,
        ...extra,
      });
      if (result.error || result.status !== 0) {
        const errorText = String(
          result.error || result.stderr || result.stdout || `exit ${result.status}`,
        )
          .replaceAll(temporary, "<temporary>")
          .slice(-4000);
        throw new Error(
          `${command} ${args.join(" ").replaceAll(temporary, "<temporary>")}: ${errorText}`,
        );
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        elapsedSeconds: Number(((performance.now() - began) / 1000).toFixed(3)),
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
      };
    }
    const baselineCommit = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
    const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
    }).stdout;
    const version = run("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: root,
    }).stdout.trim();
    if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error("Unsupported build version stamp");
    const go = JSON.parse(
      run("go", ["env", "-json", "GOVERSION", "GOROOT", "GOHOSTOS", "GOHOSTARCH"]).stdout,
    );
    if (go.GOVERSION !== toolchain)
      throw new Error(`Toolchain mismatch: ${go.GOVERSION} / ${toolchain}`);
    const modules = parseGoJSONStream(
      run("go", ["list", "-mod=readonly", "-m", "-json", "all"]).stdout,
    );
    if (modules.some((item) => item.Replace)) throw new Error("Replaced modules are unsupported");
    const moduleVerification = run("go", ["mod", "verify"]).stdout.trim();
    const inputs = [
      "scripts/go-math-reach.mjs",
      "scripts/go-math-reach-analysis.mjs",
      "scripts/license-probes/math-reach/source-map.go",
      "scripts/build-wasm.mjs",
      "justfile",
      "bun.lock",
      "package.json",
    ].map((file) => ({ file, sha256: sha256(readFileSync(join(root, file))) }));
    const sourceMapTool = join(temporary, "source-map");
    run("go", [
      "build",
      "-trimpath",
      "-o",
      sourceMapTool,
      join(root, "scripts/license-probes/math-reach/source-map.go"),
    ]);
    const binaryenPackage = JSON.parse(
      readFileSync(join(root, "node_modules/binaryen/package.json"), "utf8"),
    );
    const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies
      .binaryen;
    if (binaryenPackage.version !== declared)
      throw new Error("Installed Binaryen does not match exact manifest pin");
    const optimizer = join(root, "node_modules/binaryen/bin/wasm-opt");
    const optimizerIdentity = run(process.execPath, [optimizer, "--version"], {
      cwd: root,
    }).stdout.trim();
    report = {
      schemaVersion: 1,
      startedAt: started,
      baselineCommit,
      baselineDirty: status !== "",
      baselineStatus: status.trimEnd().split("\n").filter(Boolean),
      toolchain,
      host: {
        nodeVersion: process.version,
        nodePlatform: process.platform,
        nodeArchitecture: process.arch,
        goos: go.GOHOSTOS,
        goarch: go.GOHOSTARCH,
      },
      buildEnvironment: {
        GOWORK: "off",
        GOENV: "off",
        GOFLAGS: "",
        CGO_ENABLED: "0",
        GOEXPERIMENT: "",
        GOFIPS140: "off",
        GOAMD64: "v1",
        GOARM64: "v8.0",
      },
      sourceSnapshot: source,
      inputs,
      moduleVerification,
      modules: modules
        .filter((item) => !item.Main)
        .map(({ Path, Version, Sum, GoModSum }) => ({
          path: Path,
          version: Version,
          sum: Sum,
          goModSum: GoModSum,
        })),
      toolchainLicenseSha256: sha256(readFileSync(join(go.GOROOT, "LICENSE"))),
      binaryen: {
        version: binaryenPackage.version,
        commandVersion: optimizerIdentity,
        cliSha256: sha256(readFileSync(optimizer)),
        indexSha256: sha256(readFileSync(join(root, "node_modules/binaryen/index.js"))),
        flags: wasmFlags,
      },
      wasmBuildStamp: { version, buildTime: started },
      targets: [],
      scope:
        "First linker-retention parents from actual release-shaped Go builds, not a full call graph or per-instruction provenance. Product native/WASM artifacts are compiled and inspected, not executed; helper and build tooling run on the host. Inlining, constants, indirect/reflection reach and surviving optimizer code attribution require further review. No license exclusion or policy compliance is established.",
    };
    const buildinfo = "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/buildinfo";
    for (const [GOOS, GOARCH] of targets) {
      const inventoryRun = run(sourceMapTool, [
        "--goroot",
        go.GOROOT,
        "--goos",
        GOOS,
        "--goarch",
        GOARCH,
      ]);
      const inventory = JSON.parse(inventoryRun.stdout);
      const selectedRun = run("go", ["list", "-mod=readonly", "-json", "math", "math/cmplx"], {
        env: { ...env, GOOS, GOARCH },
      });
      const selected = parseGoJSONStream(selectedRun.stdout)
        .flatMap((pkg) =>
          [...(pkg.GoFiles ?? []), ...(pkg.SFiles ?? [])].map(
            (file) => `src/${pkg.ImportPath}/${file}`,
          ),
        )
        .sort();
      const inventoried = inventory.sources.map((item) => item.path).sort();
      if (JSON.stringify(selected) !== JSON.stringify(inventoried))
        throw new Error(
          `Source helper selection disagrees with pinned go list for ${GOOS}/${GOARCH}`,
        );
      const commands = GOOS === "js" ? ["kernel"] : ["aae", "aae-mcp"];
      for (const command of commands) {
        const name = `${command}-${GOOS}-${GOARCH}`;
        const artifact = join(temporary, name);
        const dependencyPreflight = run(
          "go",
          ["list", "-mod=readonly", "-buildvcs=false", "-deps", "-json", `./cmd/${command}`],
          { env: { ...env, GOOS, GOARCH } },
        );
        const dependencies = parseGoJSONStream(dependencyPreflight.stdout);
        if (dependencies.some((pkg) => pkg.Error || pkg.Incomplete))
          throw new Error(`Incomplete dependency selection for ${name}`);
        const flags =
          GOOS === "js"
            ? `-s -w -dumpdep -X ${buildinfo}.Version=${version} -X ${buildinfo}.BuildTime=${started}`
            : "-dumpdep";
        const args = [
          "build",
          "-mod=readonly",
          "-buildvcs=false",
          "-trimpath",
          `-ldflags=${flags}`,
          "-o",
          artifact,
          `./cmd/${command}`,
        ];
        const built = run("go", args, { env: { ...env, GOOS, GOARCH } });
        let graph;
        try {
          graph = parseDumpDependencies(built.stdout + built.stderr);
        } catch (error) {
          throw new Error(
            `${name}: ${error.message}; trace prefix ${JSON.stringify((built.stdout + built.stderr).slice(0, 200))}`,
          );
        }
        const mathReach = analyzeMathReach(graph, inventory);
        const record = {
          command,
          target: `${GOOS}/${GOARCH}`,
          buildArguments: args.map((arg) => arg.replaceAll(temporary, "<temporary>")),
          elapsedSeconds: built.elapsedSeconds,
          buildStdoutSha256: built.stdoutSha256,
          buildStderrSha256: built.stderrSha256,
          dependencyPreflight: {
            stdoutSha256: dependencyPreflight.stdoutSha256,
            stderrSha256: dependencyPreflight.stderrSha256,
            packages: dependencies.length,
            runtimeModules: [
              ...new Set(
                dependencies
                  .filter((pkg) => pkg.Module && !pkg.Module.Main)
                  .map((pkg) => `${pkg.Module.Path}@${pkg.Module.Version}`),
              ),
            ].sort(),
          },
          artifact: {
            bytes: readFileSync(artifact).length,
            sha256: sha256(readFileSync(artifact)),
          },
          sourceInventorySha256: inventoryRun.stdoutSha256,
          selectedFilesVerifiedAgainstGoList: true,
          selectedGoListSha256: selectedRun.stdoutSha256,
          sourceInventory: inventory,
          linker: {
            format: graph.format,
            edgeCount: graph.edges.length,
            symbolCount: graph.symbols.length,
            roots: graph.roots,
          },
          mathReach,
        };
        if (GOOS === "js") {
          const finalPath = join(temporary, "optimized.wasm");
          const namedPath = join(temporary, "optimized-named.wasm");
          const namedRawPath = join(temporary, "named-raw.wasm");
          const namedArgs = args.map((arg) =>
            arg === artifact ? namedRawPath : arg.replace("-ldflags=-s -w ", "-ldflags=-w "),
          );
          const namedBuild = run("go", namedArgs, { env: { ...env, GOOS, GOARCH } });
          const rawInspection = inspectWasm(readFileSync(artifact));
          const namedRawBuffer = readFileSync(namedRawPath);
          const namedRawInspection = inspectWasm(namedRawBuffer);
          if (rawInspection.nonCustomSha256 !== namedRawInspection.nonCustomSha256)
            throw new Error(
              "Named raw WASM diagnostic does not match release-shaped non-custom section bytes",
            );
          const optimized = run(process.execPath, [
            optimizer,
            artifact,
            ...wasmFlags,
            "-o",
            finalPath,
          ]);
          const named = run(process.execPath, [
            optimizer,
            namedRawPath,
            ...wasmFlags,
            "--debuginfo",
            "-o",
            namedPath,
          ]);
          const finalBuffer = readFileSync(finalPath);
          const namedBuffer = readFileSync(namedPath);
          const finalInspection = inspectWasm(finalBuffer);
          const namedInspection = inspectWasm(namedBuffer);
          if (
            ![readFileSync(artifact), namedRawBuffer, finalBuffer, namedBuffer].every((buffer) =>
              WebAssembly.validate(buffer),
            )
          )
            throw new Error("Go/Binaryen artifact failed host WebAssembly validation");
          const optimizedNames = verifiedOptimizedNames(
            finalInspection,
            namedInspection,
            mathReach,
          );
          record.optimizedWasm = {
            bytes: finalBuffer.length,
            sha256: sha256(finalBuffer),
            elapsedSeconds: optimized.elapsedSeconds,
            stdoutSha256: optimized.stdoutSha256,
            stderrSha256: optimized.stderrSha256,
            validatedByHostWebAssembly: true,
            inspection: compactWasmInspection(finalInspection, mathReach),
            namedDiagnostic: {
              bytes: namedBuffer.length,
              sha256: sha256(namedBuffer),
              elapsedSeconds: named.elapsedSeconds,
              stdoutSha256: named.stdoutSha256,
              stderrSha256: named.stderrSha256,
              ...optimizedNames,
              validatedByHostWebAssembly: true,
              raw: {
                bytes: namedRawBuffer.length,
                sha256: sha256(namedRawBuffer),
                nonCustomSectionsMatch: true,
                validatedByHostWebAssembly: true,
                inspection: compactWasmInspection(namedRawInspection, mathReach),
                buildStdoutSha256: namedBuild.stdoutSha256,
                buildStderrSha256: namedBuild.stderrSha256,
                buildArguments: namedArgs.map((arg) => arg.replaceAll(temporary, "<temporary>")),
              },
            },
            scope:
              "Raw companion names are backed by identical raw non-custom bytes. Optimized companion names are accepted only when final non-custom bytes also match; a mismatch leaves actual optimized source attribution unresolved. No missing name establishes source exclusion; linker-reached code may be inlined or removed by Binaryen.",
          };
        }
        report.targets.push(record);
        process.stderr.write(`Inspected ${command} ${GOOS}/${GOARCH}\n`);
      }
    }
    if (snapshotKernel(kernelRoot).sha256 !== source.sha256)
      throw new Error("Kernel source changed during inspection; rerun for coherent evidence");
    if (snapshotKernel(snapshot).sha256 !== source.sha256)
      throw new Error("Diagnostic mutated its source snapshot");
    for (const input of inputs) {
      if (sha256(readFileSync(join(root, input.file))) !== input.sha256)
        throw new Error(`Diagnostic input changed during inspection: ${input.file}`);
    }
    report.moduleVerificationAfterBuilds = run("go", ["mod", "verify"]).stdout.trim();
    report.sourceUnchangedDuringInspection = true;
    report.completedAt = new Date().toISOString();
    report.decision =
      "Diagnostic evidence only. Existing SunPro/Cephes runtime findings remain open pending source attribution and reviewed replacement/exclusion evidence.";
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.output), output);
    else process.stdout.write(output);
    return report;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDiagnostic(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
