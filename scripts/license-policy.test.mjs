import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  digest,
  binaryEvidenceFindings,
  evidenceFindings,
  inputFiles,
  inputHashes,
  renderNotices,
  releaseFindings,
  run,
  validateInventory,
} from "./generate-licenses.mjs";
import { defaultPolicy, licenseAllowed, policyFindings } from "./license-policy.mjs";

test("SPDX choice, combined obligations and malformed expressions fail closed", () => {
  for (const expression of [
    "MIT",
    "MIT OR GPL-3.0",
    "(MIT OR GPL-3.0) AND Apache-2.0",
    "BSD-3-Clause AND MIT",
  ])
    assert.equal(licenseAllowed(expression, defaultPolicy.code), true, expression);
  for (const expression of [
    "MIT AND GPL-3.0",
    "ISC",
    "OFL-1.1",
    "MIT WITH Classpath-exception-2.0",
    "MIT; process.exit()",
    "MIT OR",
    "(MIT",
    "MIT)",
    "",
    "OR MIT",
  ])
    assert.equal(licenseAllowed(expression, defaultPolicy.code), false, expression);
});

test("font permission cannot approve code and missing evidence still blocks a permitted license", () => {
  const entry = {
    ecosystem: "npm",
    name: "font",
    version: "1.0",
    scope: "runtime",
    license: "OFL-1.1",
    texts: [{ file: "LICENSE", text: "font license" }],
  };
  const policy = { ...defaultPolicy, assets: ["OFL-1.1"] };
  assert.equal(policyFindings([entry], policy).length, 1);
  assert.deepEqual(policyFindings([{ ...entry, asset: true }], policy), []);
  assert.equal(
    policyFindings([{ ...entry, asset: true, texts: [] }], policy)[0].kind,
    "missing-text",
  );
  assert.deepEqual(policyFindings([{ ...entry, scope: "development" }], policy), []);
  assert.equal(
    evidenceFindings([
      { ...entry, license: "MIT", issues: ["README declares MIT but license grant is absent"] },
    ])[0].kind,
    "evidence",
  );
});

test("notice generation includes verbatim runtime evidence, never tool-only text", () => {
  const entry = {
    ecosystem: "go",
    name: "example",
    version: "v1",
    license: "MIT",
    scope: "runtime",
    texts: [{ file: "LICENSE", text: "Copyright Example\nAll rights reserved.\n" }],
  };
  const output = renderNotices([
    entry,
    {
      ...entry,
      name: "test-tool",
      scope: "development",
      texts: [{ file: "LICENSE", text: "SECRET TOOL TEXT" }],
    },
  ]);
  assert.ok(output.includes(entry.texts[0].text));
  assert.ok(!output.includes("SECRET TOOL TEXT"));
  assert.ok(output.includes("LICENSES.chromium.html"));
});

test("release scope blocks runtime evidence and unresolved identities, keeping tool-only gaps visible", () => {
  const entry = {
    ecosystem: "go",
    name: "example",
    version: "v1",
    scope: "runtime",
    license: "MIT",
    texts: [{ file: "README", text: "MIT declaration" }],
    issues: ["Missing full license"],
  };
  const runtime = evidenceFindings([entry]);
  assert.equal(releaseFindings([entry], runtime).length, 1);
  const development = { ...entry, scope: "development" };
  assert.deepEqual(releaseFindings([development], evidenceFindings([development])), []);
  assert.equal(
    releaseFindings([development], [{ name: "missing-package", version: "v2", kind: "evidence" }])
      .length,
    1,
  );
});

test("a missing binary audit or removed finding cannot approve Electron's runtime under its wrapper MIT grant", () => {
  const manifest = {
    entries: [
      { ecosystem: "npm", name: "electron", version: "1.0.0", scope: "runtime", license: "MIT" },
    ],
    externalNotices: { version: "1.0.0", artifacts: [], components: [], findings: [] },
  };
  assert.equal(releaseFindings(manifest.entries, binaryEvidenceFindings(manifest)).length, 1);
  assert.throws(
    () => binaryEvidenceFindings({ ...manifest, externalNotices: undefined }),
    /audit is missing/,
  );
  assert.throws(
    () =>
      binaryEvidenceFindings({
        ...manifest,
        externalNotices: { ...manifest.externalNotices, version: "0.9.0" },
      }),
    /locked version/,
  );
});

test("audit checks reject stale dependency inputs, notices, duplicate entries and edited evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aae-license-check-"));
  try {
    for (const file of inputFiles) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(
        path.join(root, file),
        file === "docs/licenses/policy.json" ? JSON.stringify(defaultPolicy) : "fixture input",
      );
    }
    const text = "Copyright Example\nMIT license evidence";
    const entry = {
      ecosystem: "go",
      name: "example",
      version: "v1",
      scope: "runtime",
      license: "MIT",
      texts: [{ file: "LICENSE", text, sha256: digest(text) }],
    };
    const manifest = {
      schemaVersion: 1,
      inputs: await inputHashes(root),
      entries: [entry],
      findings: [],
    };
    await writeFile(path.join(root, "docs/licenses/dependencies.json"), JSON.stringify(manifest));
    await mkdir(path.join(root, "apps/editor-web/public"), { recursive: true });
    await writeFile(
      path.join(root, "apps/editor-web/public/third-party-notices.txt"),
      renderNotices(manifest.entries),
    );
    validateInventory(manifest);
    assert.throws(() => validateInventory({ ...manifest, entries: [entry, entry] }), /Duplicate/);
    assert.throws(
      () =>
        validateInventory({
          ...manifest,
          entries: [{ ...entry, texts: [{ ...entry.texts[0], text: "changed" }] }],
        }),
      /digest/,
    );
    await writeFile(path.join(root, "bun.lock"), "changed dependency");
    await assert.rejects(run({ root, check: true }), /Dependency inputs/);
    await writeFile(path.join(root, "bun.lock"), "fixture input");
    await writeFile(
      path.join(root, "apps/editor-web/public/third-party-notices.txt"),
      "stale notices",
    );
    await assert.rejects(run({ root, check: true }), /notices are stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
