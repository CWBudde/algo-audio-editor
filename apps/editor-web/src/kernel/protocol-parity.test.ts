// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const protocolDir = resolve(root, "packages/kernel/internal/protocol");
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

/** How a JSON key is written: see scripts/protocol-schema.go for the Go rules. */
interface Shape {
  kind: string;
  optional: boolean;
  nullable: boolean;
}
const schema = JSON.parse(
  execFileSync("go", ["run", resolve(root, "scripts/protocol-schema.go"), protocolDir], {
    encoding: "utf8",
    timeout: 60000,
  }),
) as {
  version: string;
  hash: string;
  methods: string[];
  payloads: Record<string, (Shape & { name: string })[]>;
};
const pinned = JSON.parse(readFileSync(resolve(protocolDir, "testdata/schema-hash.json"), "utf8"));

const { Null, Undefined, Void, Any, Unknown, TypeParameter } = ts.TypeFlags;
function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}
/** Base JSON kind; literal unions collapse to their primitive. */
function kinds(type: ts.Type): string[] {
  return members(type).flatMap((part) => {
    if (part.flags & (Null | Undefined | Void)) return [];
    if (part.flags & ts.TypeFlags.StringLike) return ["string"];
    if (part.flags & ts.TypeFlags.NumberLike) return ["number"];
    if (part.flags & ts.TypeFlags.BooleanLike) return ["boolean"];
    if (part.flags & (Any | Unknown | TypeParameter)) return ["unknown"];
    if (checker.isArrayType(part) || checker.isTupleType(part)) return ["array"];
    if (checker.getIndexInfosOfType(part).length && !checker.getPropertiesOfType(part).length)
      return ["record"];
    return ["object"];
  });
}
/**
 * Field shapes of a payload. A union (KernelResponse, the ProcessStartParams
 * variants) is one wire object: a key missing from any variant is optional.
 */
function shapes(type: ts.Type): Record<string, Shape> {
  const variants = members(checker.getNonNullableType(type));
  const names = new Set(
    variants.flatMap((variant) => checker.getPropertiesOfType(variant).map(({ name }) => name)),
  );
  const result: Record<string, Shape> = {};
  for (const name of [...names].sort()) {
    const shape = { kind: new Set<string>(), optional: false, nullable: false };
    for (const variant of variants) {
      const property = checker.getPropertyOfType(variant, name);
      if (!property) {
        shape.optional = true;
        continue;
      }
      if (property.flags & ts.SymbolFlags.Optional) shape.optional = true;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, source);
      if (members(propertyType).some((part) => part.flags & Null)) shape.nullable = true;
      for (const kind of kinds(propertyType)) shape.kind.add(kind);
    }
    result[name] = { ...shape, kind: [...shape.kind].sort().join(" | ") };
  }
  return result;
}
function fields(type: ts.Type): string[] {
  return Object.keys(shapes(type));
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
function payload(goName: string) {
  const mapping = inline[goName];
  if (mapping) return methodPayload(...mapping);
  if (nested[goName]) return arrayMember(...nested[goName]);
  return declared(renamed[goName] ?? goName);
}

/**
 * Deliberate TypeScript deviations from the Go wire shape, keyed by Go
 * payload and JSON field. Each entry states the TS side's shape and why the
 * difference is safe; stale entries fail below.
 */
const tsDiffers: Record<string, { ts: Partial<Shape>; why: string }> = {
  "DocumentInfoResult.format": {
    ts: { optional: true },
    why: 'Go always writes format ("" without a source container). TS stays optional so editor fixtures need not spell it; readers already treat absent like "" (export defaults to wav)',
  },
  "ProcessStartParams.gainDb": {
    ts: { optional: true },
    why: "TS → Go only: the discriminated union requires gainDb for gain alone; Go decodes an absent value as 0 dB",
  },
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
  it("pins the Go schema hash to the ABI version", () => {
    expect(
      { version: PROTOCOL_VERSION, hash: schema.hash },
      "protocol shape changed: bump protocol.Version/PROTOCOL_VERSION and re-pin testdata/schema-hash.json (see TestSchemaHashPinsVersion)",
    ).toEqual(pinned);
  });
  it.each(Object.entries(schema.payloads))(
    "mirrors %s JSON field kind, optionality and nullability",
    (name, goFields) => {
      const expected = Object.fromEntries(
        goFields.map(({ name: field, ...shape }) => [
          field,
          { ...shape, ...tsDiffers[`${name}.${field}`]?.ts },
        ]),
      );
      const { data: _transferred, ...actual } = shapes(payload(name));
      expect(actual).toEqual(expected);
    },
  );
  it.each(Object.keys(tsDiffers))("still needs the %s allowance", (key) => {
    const [name, field] = key.split(".");
    const goField = schema.payloads[name]?.find((candidate) => candidate.name === field);
    if (!goField) throw new Error(`Stale allowance ${key}: no such Go field`);
    const { name: _name, ...goShape } = goField;
    expect(shapes(payload(name))[field]).not.toEqual(goShape);
  });
});

/** JSON-level check that a Go-marshalled value parses as the declared TS type. */
function conformance(value: unknown, type: ts.Type, path: string): string[] {
  if (value === null)
    return members(type).some((part) => part.flags & (Null | Any | Unknown | TypeParameter))
      ? []
      : [`${path}: null where ${checker.typeToString(type)} is not nullable`];
  let closest: string[] | undefined;
  for (const part of members(type)) {
    if (part.flags & (Null | Undefined | Void)) continue;
    const errors = conformsToMember(value, part, path);
    if (!errors.length) return [];
    if (!closest || errors.length < closest.length) closest = errors;
  }
  return closest ?? [`${path}: no JSON type in ${checker.typeToString(type)}`];
}
function conformsToMember(value: unknown, part: ts.Type, path: string): string[] {
  const mismatch = [`${path}: ${JSON.stringify(value)} is not ${checker.typeToString(part)}`];
  if (part.flags & (Any | Unknown | TypeParameter)) return [];
  if (part.isStringLiteral() || part.isNumberLiteral()) return value === part.value ? [] : mismatch;
  if (part.flags & ts.TypeFlags.BooleanLiteral)
    return String(value) === checker.typeToString(part) ? [] : mismatch;
  if (part.flags & ts.TypeFlags.String) return typeof value === "string" ? [] : mismatch;
  if (part.flags & ts.TypeFlags.Number) return typeof value === "number" ? [] : mismatch;
  if (checker.isArrayType(part)) {
    if (!Array.isArray(value)) return mismatch;
    const [item] = checker.getTypeArguments(part as ts.TypeReference);
    return value.flatMap((entry, index) => conformance(entry, item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return mismatch;
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const properties = checker.getPropertiesOfType(part);
  for (const property of properties) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, source);
    if (Object.hasOwn(record, property.name))
      errors.push(...conformance(record[property.name], propertyType, `${path}.${property.name}`));
    // Bulk data is transferred beside the JSON metadata, never inside it.
    else if (!(property.flags & ts.SymbolFlags.Optional) && property.name !== "data")
      errors.push(`${path}.${property.name}: required by TypeScript but absent`);
  }
  const index = checker.getIndexInfoOfType(part, ts.IndexKind.String);
  for (const key of Object.keys(record)) {
    if (properties.some((property) => property.name === key)) continue;
    if (index) errors.push(...conformance(record[key], index.type, `${path}.${key}`));
    else errors.push(`${path}.${key}: not declared by TypeScript`);
  }
  return errors;
}

// Shared with the Go *WireGolden tests: Go marshals, TypeScript parses.
const goldens = Object.entries({
  "process-jobs.json": (text: string) => ({ ProcessJobResult: JSON.parse(text) }),
  "document.json": JSON.parse,
  "analysis.json": JSON.parse,
  "effects.json": JSON.parse,
}).flatMap(([file, parse]) =>
  Object.entries(
    parse(readFileSync(resolve(protocolDir, "testdata", file), "utf8")) as Record<
      string,
      unknown[]
    >,
  ).map(([name, values]) => [file, name, values] as const),
);

describe("Go-marshalled golden payloads", () => {
  it("covers process jobs, documents, analysis and effects", () => {
    expect(new Set(goldens.map(([file]) => file)).size).toBe(4);
  });
  it.each(goldens)("%s %s values parse as their TypeScript payload", (_file, name, values) => {
    expect(values.length).toBeGreaterThan(0);
    const type = declared(name);
    expect(values.flatMap((value, index) => conformance(value, type, `${name}[${index}]`))).toEqual(
      [],
    );
  });
});
