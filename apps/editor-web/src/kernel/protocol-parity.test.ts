// @vitest-environment node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  type DocumentInfoResult,
  PROTOCOL_VERSION,
  type ProcessCandidate,
  type ProcessJobResult,
} from "@aae/protocol";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const sourcePath = resolve(root, "packages/protocol/src/index.ts");
const program = ts.createProgram([sourcePath], { strict: true, noEmit: true });
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(sourcePath);
if (!sourceFile) throw new Error("Missing TypeScript protocol");
const source: ts.SourceFile = sourceFile;
const declarations = new Map<string, ts.Type>();
for (const node of source.statements) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    declarations.set(node.name.text, checker.getTypeAtLocation(node));
  }
}
const schema = JSON.parse(
  execFileSync(
    "go",
    [
      "run",
      resolve(root, "scripts/protocol-schema.go"),
      resolve(root, "packages/kernel/internal/protocol"),
    ],
    { encoding: "utf8", timeout: 60000 },
  ),
) as { version: string; methods: string[]; payloads: Record<string, string[]> };

function fields(type: ts.Type): string[] {
  return [
    ...new Set(
      (type.isUnion() ? type.types : [type]).flatMap((member) =>
        checker.getPropertiesOfType(member).map((property) => property.name),
      ),
    ),
  ].sort();
}
function declared(name: string) {
  const type = declarations.get(name);
  if (!type) throw new Error(`Missing TypeScript payload ${name}`);
  return type;
}
function methodPayload(method: string, side: "params" | "result") {
  const entry = checker.getPropertyOfType(declared("KernelMethods"), method);
  if (!entry) throw new Error(`Missing method ${method}`);
  const property = checker.getPropertyOfType(
    checker.getTypeOfSymbolAtLocation(entry, source),
    side,
  );
  if (!property) throw new Error(`Missing ${method}.${side}`);
  return checker.getTypeOfSymbolAtLocation(property, source);
}

// Go uses a few longer names and metadata-only types; TypeScript adds the
// transferred ArrayBuffer on these replies. Inline payloads are checked too.
const renamed: Record<string, string> = {
  Response: "KernelResponse",
  DocumentExportInfo: "ExportInfo",
  PCMReadInfo: "PCMReadResult",
  BinaryDocumentInfo: "BinaryDocumentResult",
  EffectsPreviewParams: "EffectPreviewParams",
  EffectsPreviewResult: "EffectPreviewResult",
  EffectsSessionParams: "EffectSessionParams",
  EffectsMetersResult: "EffectMetersResult",
  EffectsResponseParams: "EffectResponseParams",
  EffectsResponseInfo: "EffectResponseResult",
  EffectsIRInfo: "EffectIRResult",
};
const inline: Record<string, [string, "params" | "result"]> = {
  MetadataGetParams: ["metadata.get", "params"],
  MetersConfigureParams: ["meters.configure", "params"],
  EffectsListParams: ["effects.list", "params"],
  EffectsListResult: ["effects.list", "result"],
  EffectsStopResult: ["effects.preview.stop", "result"],
  EffectsIRLoadParams: ["effects.ir.load", "params"],
  EffectsIRRemoveParams: ["effects.ir.remove", "params"],
  EffectsIRRemoveResult: ["effects.ir.remove", "result"],
};

function arrayMember(owner: string, field: string) {
  const property = checker.getPropertyOfType(declared(owner), field);
  if (!property) throw new Error(`Missing ${owner}.${field}`);
  const array = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, source));
  const item = checker.getIndexTypeOfType(array, ts.IndexKind.Number);
  if (!item) throw new Error(`Missing ${owner}.${field} item`);
  return item;
}
const nested: Record<string, [string, string]> = {
  EffectNode: ["EffectGraph", "nodes"],
  EffectConnection: ["EffectGraph", "connections"],
  EffectOption: ["EffectParameterDescriptor", "options"],
};

describe("Go/TypeScript protocol parity", () => {
  it("accepts the existing empty format and null process candidate wire values", () => {
    expectTypeOf<ProcessJobResult["candidate"]>().toEqualTypeOf<ProcessCandidate | null>();
    expectTypeOf<"">().toExtend<DocumentInfoResult["format"]>();
  });
  it("mirrors the ABI version and every method name", () => {
    expect(PROTOCOL_VERSION).toBe(Number(schema.version));
    expect(fields(declared("KernelMethods"))).toEqual(schema.methods);
  });
  it.each(Object.entries(schema.payloads))(
    "mirrors %s JSON field names including embedded payloads",
    (name, expected) => {
      const mapping = inline[name];
      const type = mapping
        ? methodPayload(...mapping)
        : nested[name]
          ? arrayMember(...nested[name])
          : declared(renamed[name] ?? name);
      expect(fields(type).filter((field) => field !== "data")).toEqual(expected);
    },
  );
});
