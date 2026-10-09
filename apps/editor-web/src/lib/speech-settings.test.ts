import type { DocumentInfoResult } from "@aae/protocol";
import { describe, expect, it } from "vitest";
import { TEST_SPEECH_CATALOG } from "@/speech/catalog-fixture";
import {
  emptySpeechForm,
  formatSpeechTime,
  speechFormForCatalog,
  speechKey,
  speechModelDefaults,
  speechParams,
  speechPlacement,
  speechTextLength,
} from "./speech-settings";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "voice.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 480000,
  bitDepth: 32,
  float: true,
};
const ready = speechFormForCatalog(emptySpeechForm(42), TEST_SPEECH_CATALOG);

describe("speech form", () => {
  it("starts from the catalog default model, its voice, temperature and sample text", () => {
    expect(ready).toMatchObject({
      model: "english_2026-01",
      voice: "alba",
      temperatureText: "0.3",
      text: "Hello world.",
      seedText: "42",
      samplerStepsText: "1",
      eosThresholdText: "-4",
      levelText: "0",
    });
  });
  it("keeps written text on a model switch but swaps another model's sample text", () => {
    const german = TEST_SPEECH_CATALOG.models[1];
    expect(speechModelDefaults(ready, german, TEST_SPEECH_CATALOG)).toMatchObject({
      model: "german_24l",
      voice: "juergen",
      temperatureText: "0.5",
      text: "Hallo Welt.",
    });
    expect(
      speechModelDefaults({ ...ready, text: "Mein Text." }, german, TEST_SPEECH_CATALOG).text,
    ).toBe("Mein Text.");
  });
  it("repairs a remembered voice the model no longer offers", () => {
    expect(speechFormForCatalog({ ...ready, voice: "nobody" }, TEST_SPEECH_CATALOG).voice).toBe(
      "alba",
    );
  });
});

describe("speechParams", () => {
  it("parses a valid form into speech.generate parameters", () => {
    expect(speechParams(ready, TEST_SPEECH_CATALOG)).toEqual({
      params: {
        model: "english_2026-01",
        voice: "alba",
        text: "Hello world.",
        temperature: 0.3,
        samplerSteps: 1,
        eosThreshold: -4,
        seed: 42,
        levelDb: 0,
      },
    });
  });
  it.each([
    [{ text: "" }, "text"],
    [{ text: "  \n " }, "text"],
    [{ text: "!!! …" }, "text"],
    [{ text: "a".repeat(5001) }, "text"],
    [{ temperatureText: "2.5" }, "temperature"],
    [{ temperatureText: "" }, "temperature"],
    [{ samplerStepsText: "0" }, "samplerSteps"],
    [{ samplerStepsText: "1.5" }, "samplerSteps"],
    [{ samplerStepsText: "65" }, "samplerSteps"],
    [{ eosThresholdText: "x" }, "eosThreshold"],
    [{ seedText: "-1" }, "seed"],
    [{ seedText: "4294967296" }, "seed"],
    [{ levelText: "1" }, "level"],
    [{ levelText: "-121" }, "level"],
    [{ voice: "juergen" }, "model"],
  ])("rejects %j as %s", (change, error) => {
    expect(speechParams({ ...ready, ...change }, TEST_SPEECH_CATALOG).error).toBe(error);
  });
  it("needs the catalog", () => {
    expect(speechParams(ready, undefined).error).toBe("model");
  });
  it("counts Unicode code points like Go, not UTF-16 units", () => {
    const astral = "𝔸".repeat(5000);
    expect(astral.length).toBe(10000);
    expect(speechTextLength(astral)).toBe(5000);
    expect(speechParams({ ...ready, text: astral }, TEST_SPEECH_CATALOG).params).toBeDefined();
    expect(speechParams({ ...ready, text: `${astral}!` }, TEST_SPEECH_CATALOG).error).toBe("text");
  });
  it("keys candidates by every synthesis and level field", () => {
    const params = speechParams(ready, TEST_SPEECH_CATALOG).params;
    if (!params) throw new Error("invalid");
    expect(speechKey(params)).toBe(speechKey({ ...params }));
    expect(speechKey(params)).not.toBe(speechKey({ ...params, seed: 43 }));
    expect(speechKey(params)).not.toBe(speechKey({ ...params, levelDb: -6 }));
    expect(speechKey(params)).not.toBe(speechKey({ ...params, text: "Hello world!" }));
  });
});

describe("speechPlacement", () => {
  it("describes insertion, replacement and an empty document", () => {
    expect(speechPlacement(info, { start: 72000, end: 72000, channelMask: 3 })).toBe(
      "Inserts at 0:01.500 (both channels)",
    );
    expect(speechPlacement(info, { start: 48000, end: 3_000_000, channelMask: 1 })).toBe(
      "Replaces 0:01.000–1:02.500 (left)",
    );
    expect(speechPlacement(info, { start: 0, end: 10, channelMask: 2 })).toBe(
      "Replaces 0:00.000–0:00.000 (right)",
    );
    expect(speechPlacement({ ...info, frames: 0 }, { start: 0, end: 0, channelMask: 3 })).toBe(
      "Creates audio in the empty document",
    );
    expect(
      speechPlacement({ ...info, channels: 4 }, { start: 0, end: 0, channelMask: 0b0101 }),
    ).toBe("Inserts at 0:00.000 (channels 1, 3)");
    expect(speechPlacement({ ...info, channels: 1 }, { start: 0, end: 0, channelMask: 1 })).toBe(
      "Inserts at 0:00.000 (mono)",
    );
  });
  it("formats minutes beyond an hour", () => {
    expect(formatSpeechTime(48000 * 3725.25, 48000)).toBe("62:05.250");
  });
});
