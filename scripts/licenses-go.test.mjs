import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expectedGoIdentities,
  identifyGoLicense,
  parseGoJSONStream,
  sourceNotices,
} from "./licenses-go.mjs";

test("Go JSON streams preserve nested modules and braces inside escaped strings", () => {
  const input = `${JSON.stringify({ Path: "module", Module: { Version: "v1.0.0" }, Message: 'brace } and "quote"' })}\n${JSON.stringify({ Standard: true })}`;
  assert.deepEqual(parseGoJSONStream(input), [
    { Path: "module", Module: { Version: "v1.0.0" }, Message: 'brace } and "quote"' },
    { Standard: true },
  ]);
  for (const malformed of ['{"Path":', "{} trailing", "}", '"string"']) {
    assert.throws(() => parseGoJSONStream(malformed));
  }
});

test("license evidence does not turn unsupported or absent licenses into MIT", () => {
  assert.equal(
    identifyGoLicense("This is free and unencumbered software released into the public domain."),
    "Unlicense",
  );
  assert.equal(identifyGoLicense("See LICENSE for details"), "UNKNOWN");
  assert.equal(identifyGoLicense("Permission is hereby granted, free of charge"), "MIT");
  assert.equal(
    identifyGoLicense("Redistribution and use in source and binary forms. Neither the name"),
    "BSD-3-Clause",
  );
  assert.equal(
    identifyGoLicense("Redistribution and use in source and binary forms"),
    "BSD-2-Clause",
  );
  assert.equal(
    identifyGoLicense(
      "Redistribution and use in source and binary forms\n1. Redistributions of source code must retain this notice.",
    ),
    "BSD-1-Clause",
  );
  assert.equal(
    identifyGoLicense(
      "The MCP project is undergoing a licensing transition\nApache License\nVersion 2.0\nMIT License\nDocumentation CC-BY-4.0",
    ),
    "Apache-2.0 AND MIT",
  );
});

test("identity guard uses pinned declarations without requiring Go or assuming replacement licenses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aae-go-license-test-"));
  try {
    const kernel = path.join(root, "packages/kernel");
    await mkdir(kernel, { recursive: true });
    const file = path.join(kernel, "go.mod");
    await writeFile(
      file,
      "module local/module\ngo 1.25.0\ntoolchain go1.26.8\nrequire (\n example.com/one v1.0.0\n example.com/two v2.0.0 // indirect\n)\nrequire example.com/three v3.0.0\n",
    );
    assert.deepEqual(await expectedGoIdentities({ root }), [
      { ecosystem: "go", name: "example.com/one", version: "v1.0.0" },
      { ecosystem: "go", name: "example.com/three", version: "v3.0.0" },
      { ecosystem: "go", name: "example.com/two", version: "v2.0.0" },
      { ecosystem: "go", name: "Go runtime and standard library", version: "go1.26.8" },
    ]);
    await writeFile(
      file,
      "module local/module\nreplace example.com/a => ../a\ntoolchain go1.26.8\n",
    );
    await assert.rejects(expectedGoIdentities({ root }), /replaced/);
    await writeFile(file, "module local/module\ngo 1.25.0\n");
    await assert.rejects(expectedGoIdentities({ root }), /pinned toolchain/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded notices after package declaration are retained with permission terms", () => {
  const source =
    "// Copyright 2009 The Go Authors.\n// BSD-style terms.\n\npackage math\n\n// Copyright (C) 1993 Sun Microsystems.\n// Permission to use, copy and modify provided notice is preserved.\n\nfunc Log() {}\n// Copyright returns a bit in a recording.\n";
  const notices = sourceNotices(source);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /provided notice is preserved/);
  assert.equal(
    sourceNotices("/* Copyright (c) 2026 Example.\nPermission is hereby granted. */").length,
    1,
  );
});
