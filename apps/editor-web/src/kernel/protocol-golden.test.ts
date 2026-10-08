// @vitest-environment node
import type {
  AnalysisJobResult,
  AnalysisSpectrumResult,
  DocumentInfoResult,
  EditResult,
  EffectDescriptor,
} from "@aae/protocol";
import { describe, expect, it } from "vitest";
import analysisGolden from "../../../../packages/kernel/internal/protocol/testdata/analysis.json?raw";
import documentGolden from "../../../../packages/kernel/internal/protocol/testdata/document.json?raw";
import effectsGolden from "../../../../packages/kernel/internal/protocol/testdata/effects.json?raw";
import { createRackEffect, validRack } from "../lib/effect-rack";
import { validExportSelection } from "../lib/export-settings";
import { validAnalysisProgress } from "./analysis-runner";
import { validLiveSpectrum } from "./live-spectrum-runner";

// Go marshals these files (TestDocumentWireGolden, TestAnalysisWireGolden,
// TestEffectsWireGolden); protocol-parity.test.ts checks them against the
// declared types. Here the editor's own runtime validators must accept them.
const analysis = JSON.parse(analysisGolden) as {
  AnalysisJobResult: AnalysisJobResult[];
  AnalysisSpectrumResult: AnalysisSpectrumResult[];
};
const documents = JSON.parse(documentGolden) as {
  DocumentInfoResult: DocumentInfoResult[];
  EditResult: EditResult[];
};
const effects = JSON.parse(effectsGolden) as { EffectDescriptor: EffectDescriptor[] };

/** callKernel attaches the transferred buffer beside the JSON metadata. */
function withData<T extends { dataBytes: number }>(value: T): T & { data?: ArrayBuffer } {
  return value.dataBytes ? { ...value, data: new ArrayBuffer(value.dataBytes) } : value;
}

describe("Go-marshalled golden payloads in editor validators", () => {
  it.each(analysis.AnalysisJobResult.map((job) => [job.kind, job.state, job] as const))(
    "accepts %s %s analysis progress",
    (_kind, _state, job) => {
      expect(validAnalysisProgress(withData(job), { documentId: "doc-1", jobId: "job-1" })).toBe(
        true,
      );
    },
  );
  it("accepts live spectrum progress", () => {
    for (const result of analysis.AnalysisSpectrumResult)
      expect(validLiveSpectrum(withData(result))).toBe(true);
  });
  it("accepts the edited selection against its document", () => {
    for (const edit of documents.EditResult)
      expect(validExportSelection(edit.selection, edit.document)).toBe(true);
    expect(documents.DocumentInfoResult.map((info) => info.format)).toEqual(["wav", ""]);
  });
  it("builds a valid default rack from every effect descriptor", () => {
    for (const descriptor of effects.EffectDescriptor) {
      const rack = [createRackEffect(descriptor)];
      expect(validRack(rack, effects.EffectDescriptor, 3)).toBe(true);
    }
  });
});
