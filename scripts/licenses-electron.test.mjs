import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectElectronLicenses, parseChromiumNotices } from "./licenses-electron.mjs";

const product = (name, text) =>
  `<div class="product">\n<span class="title">${name}</span>\n<div class="license"><pre>${text}</pre></div></div>\n`;

test("binary notice parser preserves duplicate components, text digests and policy evidence", () => {
  const text =
    "Copyright &amp; contributors\nMozilla Public License Version 2.0\nGNU Lesser General Public License";
  const components = parseChromiumNotices(
    `${product("A &amp; B", text)}${product("A &amp; B", "ISC License")}`,
  );
  assert.deepEqual(
    components.map((entry) => [entry.name, entry.occurrence, entry.noticeLine]),
    [
      ["A & B", 1, 1],
      ["A & B", 2, 6],
    ],
  );
  assert.deepEqual(components[0].licenseFamilies, ["LGPL", "MPL"]);
  assert.equal(
    components[0].sha256,
    createHash("sha256").update(text.replace("&amp;", "&")).digest("hex"),
  );
  assert.deepEqual(components[1].licenseFamilies, ["ISC"]);
});

test("missing or changed notice markup and unknown entities fail closed", () => {
  for (const input of [
    "unrecognized",
    '<div class="product"><span class="title">Title</span>',
    product("Title", ""),
    product("Title &unknown;", "MIT"),
  ])
    assert.throws(() => parseChromiumNotices(input));
});

test("npm MIT does not approve binary notices; missing files and version drift retain blockers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aae-electron-notices-"));
  try {
    const directory = path.join(root, "apps/desktop/node_modules/electron");
    await mkdir(path.join(directory, "dist"), { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "electron", version: "1.0.0", license: "MIT" }),
    );
    await writeFile(path.join(directory, "dist/version"), "1.0.0\n");
    await writeFile(path.join(directory, "dist/LICENSE"), "Electron MIT license");
    const html = product("ffmpeg", "GNU Lesser General Public License");
    await writeFile(path.join(directory, "dist/LICENSES.chromium.html"), html);
    let result = await collectElectronLicenses({ root });
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.artifacts[1].sha256, createHash("sha256").update(html).digest("hex"));
    assert.equal(result.components.length, 1);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].message, /remain unresolved/);
    await rm(path.join(directory, "dist/LICENSES.chromium.html"));
    result = await collectElectronLicenses({ root });
    assert.match(result.findings[0].message, /evidence is incomplete/);
    await writeFile(path.join(directory, "dist/version"), "0.9.0");
    result = await collectElectronLicenses({ root });
    assert.match(result.findings[0].message, /differs from npm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
