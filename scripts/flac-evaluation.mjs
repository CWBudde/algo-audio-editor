import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGoJSONStream } from "./licenses-go.mjs";
import { readRemediationAssets, verifyRemediationSource } from "./flac-remediation.mjs";

// Opt-in source evaluation, never part of a product build or dependency graph.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.argv.slice(2);
let remediated = false;
let outputPath;
let invalid = false;
for (let i = 0; i < cli.length; i++) {
  if (cli[i] === "--remediated" && !remediated) remediated = true;
  else if (cli[i] === "--output" && !outputPath && cli[i + 1] && !cli[i + 1].startsWith("-"))
    outputPath = cli[++i];
  else invalid = true;
}
if (invalid) {
  process.stderr.write(
    "Usage: node scripts/flac-evaluation.mjs [--remediated] [--output report.json]\n",
  );
  process.exit(1);
}
const remediationAssets = remediated
  ? readRemediationAssets(join(root, "scripts/license-probes/flac-remediation"))
  : null;
const temporary = mkdtempSync(join(tmpdir(), "aae-flac-evaluation-"));
const env = { ...process.env, GOWORK: "off", GOTOOLCHAIN: "go1.26.8", CGO_ENABLED: "0" };
const report = {
  candidate: "github.com/tphakala/go-flac@v1.1.0",
  toolchain: "go1.26.8",
  targets: [],
  grants: [],
  comparisons: 0,
  failures: [],
  scope:
    "Root legal-file hashes are partial grant evidence, not a per-file or contribution/provenance audit. Runtime execution is Linux amd64 and Node js/wasm; other targets are compile-only. No browser, installed platform, corpus or editor acceptance is claimed.",
  probeSourceSha256: createHash("sha256")
    .update(readFileSync(join(root, "scripts/license-probes/flac-probe.go")))
    .digest("hex"),
};
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: temporary,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")}: ${result.error || result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
function equalFiles(left, right) {
  if (!readFileSync(left).equals(readFileSync(right)))
    throw new Error(`PCM mismatch: ${left} / ${right}`);
}
try {
  report.baselineCommit = run("git", ["rev-parse", "HEAD"], { cwd: root });
  writeFileSync(
    join(temporary, "go.mod"),
    "module flac-evaluation\n\ngo 1.26\n\nrequire github.com/tphakala/go-flac v1.1.0\n",
  );
  copyFileSync(join(root, "scripts/license-probes/flac-probe.go"), join(temporary, "main.go"));
  run("go", ["mod", "tidy"]);
  const modules = parseGoJSONStream(run("go", ["list", "-m", "-json", "all"])).filter(
    (item) => !item.Main,
  );
  const candidate = modules.find((item) => item.Path === "github.com/tphakala/go-flac");
  if (candidate?.Sum !== "h1:dyVNPFW+MVLzPvw1n3dEvBHPtKUMbQ5PHWvW/pxQMv0=")
    throw new Error("Unexpected candidate module checksum");
  report.modules = [];
  for (const module of modules) {
    const downloaded = JSON.parse(
      run("go", ["mod", "download", "-json", `${module.Path}@${module.Version}`]),
    );
    report.modules.push({
      path: module.Path,
      version: module.Version,
      sum: downloaded.Sum,
      goModSum: downloaded.GoModSum,
    });
    const directory = downloaded.Dir;
    const grants = readdirSync(directory).filter((name) =>
      /^(LICENSE|COPYING|NOTICE|THIRD_PARTY)(\.|$)/i.test(name),
    );
    report.grants.push({
      module: module.Path,
      files: grants.map((name) => ({
        name,
        sha256: createHash("sha256")
          .update(readFileSync(join(directory, name)))
          .digest("hex"),
      })),
    });
  }
  report.moduleVerification = run("go", ["mod", "verify"]);
  if (remediated) {
    const { manifest, patch } = remediationAssets;
    assert.equal(manifest.baseModule, report.candidate);
    assert.equal(manifest.baseSum, candidate.Sum);
    const source = join(temporary, "candidate-source");
    cpSync(candidate.Dir, source, { recursive: true });
    const writable = (directory) => {
      chmodSync(directory, 0o700);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) writable(path);
        else chmodSync(path, 0o600);
      }
    };
    writable(source);
    const patchPath = join(temporary, "robustness.patch");
    writeFileSync(patchPath, patch);
    run("git", ["apply", "--check", "--unidiff-zero", patchPath], { cwd: source });
    run("git", ["apply", "--unidiff-zero", patchPath], { cwd: source });
    const verifiedSourceFiles = verifyRemediationSource(source, manifest);
    run("go", ["mod", "edit", `-replace=github.com/tphakala/go-flac=${source}`]);
    report.remediation = {
      ...manifest,
      verifiedSourceFiles,
      tests: [],
      scope:
        "Local evaluation patch only; not an upstream release or product dependency. Base grants and graph above describe the verified archive.",
    };
  }
  const binary = join(temporary, "probe");
  for (const [GOOS, GOARCH] of [
    ["linux", "amd64"],
    ["linux", "arm64"],
    ["darwin", "amd64"],
    ["darwin", "arm64"],
    ["windows", "amd64"],
    ["windows", "arm64"],
    ["js", "wasm"],
  ]) {
    const output =
      GOOS === "linux" && GOARCH === "amd64" ? binary : join(temporary, `probe-${GOOS}-${GOARCH}`);
    run("go", ["build", "-buildvcs=false", "-trimpath", "-o", output, "."], {
      env: { ...env, GOOS, GOARCH },
    });
    const packages = parseGoJSONStream(
      run("go", ["list", "-buildvcs=false", "-deps", "-json", "."], {
        env: { ...env, GOOS, GOARCH },
      }),
    );
    report.targets.push({
      target: `${GOOS}/${GOARCH}`,
      runtimeModules: [
        ...new Set(
          packages
            .filter((item) => item.Module && !item.Module.Main)
            .map(
              (item) =>
                `${item.Module.Path}@${item.Module.Version}${item.Module.Replace ? "+local-remediation" : ""}`,
            ),
        ),
      ].sort(),
    });
    process.stderr.write(`Compiled ${GOOS}/${GOARCH}\n`);
  }
  const goroot = run("go", ["env", "GOROOT"]);
  if (remediated) {
    for (const [GOOS, GOARCH] of [
      ["linux", "amd64"],
      ["js", "wasm"],
    ]) {
      const args = ["test", "-json", "-count=1"];
      if (GOOS === "js")
        args.push(
          `-exec=env -i ${process.execPath} --stack-size=8192 ${join(goroot, "lib/wasm/wasm_exec_node.js")}`,
        );
      args.push("./...");
      const started = performance.now();
      const output = run("go", args, {
        cwd: join(temporary, "candidate-source"),
        env: { ...env, GOOS, GOARCH, GO_FLAC_REFERENCE_TEST: GOOS === "linux" ? "1" : "0" },
      });
      const events = parseGoJSONStream(output);
      report.remediation.tests.push({
        target: `${GOOS}/${GOARCH}`,
        command: [
          "go",
          ...args.map((arg) =>
            arg.startsWith("-exec=")
              ? "-exec=env -i <Node> --stack-size=8192 <GOROOT>/lib/wasm/wasm_exec_node.js"
              : arg,
          ),
        ],
        elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
        passedPackages: events
          .filter((event) => event.Action === "pass" && !event.Test)
          .map((event) => event.Package),
        passedTestEvents: events.filter((event) => event.Action === "pass" && event.Test).length,
        skippedTests: events
          .filter((event) => event.Action === "skip" && event.Test)
          .map(({ Package, Test }) => ({ package: Package, test: Test })),
        outputSha256: createHash("sha256").update(output).digest("hex"),
        scope:
          GOOS === "linux"
            ? "Full patched upstream suite; installed independent flac required for 128 encoder reference subcases."
            : "Full patched upstream suite in Node; native subprocess reference test explicitly skipped.",
      });
      process.stderr.write(`Tested remediated ${GOOS}/${GOARCH} upstream suite\n`);
    }
  }
  report.nativeProbes = JSON.parse(run(binary, ["probe"]));
  report.wasmProbes = JSON.parse(
    run(join(goroot, "lib/wasm/go_js_wasm_exec"), [join(temporary, "probe-js-wasm"), "probe"], {
      env: { PATH: process.env.PATH, TMPDIR: temporary },
    }),
  );
  const behavior = (values) => values.map(({ name, bytes, error }) => ({ name, bytes, error }));
  assert.deepEqual(
    behavior(report.wasmProbes),
    behavior(report.nativeProbes),
    "Native/WASM malformed-input behavior differs",
  );
  assert.equal(report.nativeProbes.find((item) => item.name === "valid")?.bytes, 16388);
  assert.equal(report.nativeProbes.find((item) => item.name === "valid")?.error, "");
  for (const name of ["bad-md5", "bad-frame-crc", "truncated-audio", "truncated-metadata"]) {
    assert.ok(
      report.nativeProbes.find((item) => item.name === name)?.error,
      `${name} was accepted`,
    );
  }
  report.nativeWasmBehaviorMatches = true;
  if (remediated) {
    for (const result of report.nativeProbes) {
      if (result.name === "valid" || result.name.startsWith("declared-0-")) {
        assert.equal(result.error, "", result.name);
        assert.equal(result.bytes, 16388, result.name);
      } else assert.ok(result.error, `${result.name} was accepted by the remediation`);
    }
    for (const values of [report.nativeProbes, report.wasmProbes]) {
      for (const name of [
        "truncated-max-seektable",
        "truncated-max-divisible-seektable",
        "truncated-divisible-seektable-within-budget",
      ]) {
        assert.ok(
          values.find((item) => item.name === name)?.allocatedBytes < 131072,
          `${name} exceeded the allocation guard`,
        );
      }
    }
    report.remediationControlsPass = true;
  }
  report.reference = run("flac", ["--version"]);
  for (const depth of [8, 16, 24, 32]) {
    for (const channels of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const samples of [1, 15, 16, 31, 4095, 4096, 4097, 9000]) {
        const source = join(temporary, "source.raw"),
          reference = join(temporary, "reference.flac"),
          encoded = join(temporary, "candidate.flac"),
          decoded = join(temporary, "decoded.raw");
        run(binary, ["generate", String(depth), String(channels), String(samples), source]);
        run("flac", [
          "--silent",
          "--force",
          "--force-raw-format",
          "--endian=little",
          "--sign=signed",
          `--channels=${channels}`,
          `--bps=${depth}`,
          "--sample-rate=48000",
          "-5",
          "-o",
          reference,
          source,
        ]);
        try {
          run(binary, ["decode", reference, decoded]);
          equalFiles(source, decoded);
          report.comparisons++;
        } catch (error) {
          report.failures.push({
            depth,
            channels,
            samples,
            stage: "candidate-decode",
            error: error.message.replaceAll(temporary, "<temporary>").slice(0, 2000),
          });
        }
        try {
          run(binary, [
            "encode",
            String(depth),
            String(channels),
            String(samples),
            source,
            encoded,
          ]);
          run("flac", [
            "--silent",
            "--force",
            "--decode",
            "--force-raw-format",
            "--endian=little",
            "--sign=signed",
            "-o",
            decoded,
            encoded,
          ]);
          equalFiles(source, decoded);
          report.comparisons++;
        } catch (error) {
          report.failures.push({
            depth,
            channels,
            samples,
            stage: "candidate-encode",
            error: error.message.replaceAll(temporary, "<temporary>").slice(0, 2000),
          });
          if (!report.secondReference && depth === 32) {
            report.secondReference = { depth, channels, samples };
            try {
              report.secondReference.version = run("ffmpeg", ["-version"]).split("\n")[0];
              run("ffmpeg", [
                "-v",
                "error",
                "-y",
                "-i",
                encoded,
                "-f",
                "s32le",
                "-c:a",
                "pcm_s32le",
                decoded,
              ]);
              equalFiles(source, decoded);
              report.secondReference.matches = true;
            } catch (referenceError) {
              report.secondReference.matches = false;
              report.secondReference.error = referenceError.message
                .replaceAll(temporary, "<temporary>")
                .slice(0, 2000);
            }
          }
        }
      }
    }
    process.stderr.write(`Compared independent ${depth}-bit PCM\n`);
  }
  report.decision = remediated
    ? report.failures.length === 0
      ? "Local remediation passes this limited probe. Do not adopt: no audited upstream tag; provenance, full corpus, editor storage/performance and platform acceptance remain open."
      : "Local remediation retains independent comparison failures; do not adopt."
    : "Do not adopt v1.1.0: independent encode failures, metadata allocation and stream-shape/count validation require remediation; provenance review remains open.";
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, output);
  else process.stdout.write(output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
