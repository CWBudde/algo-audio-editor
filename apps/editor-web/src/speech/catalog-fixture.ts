import type { SpeechCatalog, SpeechCatalogFile } from "./messages";

const file = (path: string, size: number): SpeechCatalogFile => ({
  url: `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${"a".repeat(40)}/${path}`,
  sha256: "0".repeat(64),
  size,
  path,
});

/** A two-model catalog in speech.wasm's shape for tests. */
export const TEST_SPEECH_CATALOG: SpeechCatalog = {
  default: "english_2026-01",
  models: [
    {
      name: "english_2026-01",
      label: "English (Jan 2026)",
      language: "en",
      layers: 6,
      default_voice: "alba",
      default_temperature: 0.3,
      default_text: "Hello world.",
      weights: file("english_2026-01/model.safetensors", 1000),
      tokenizer: file("english_2026-01/tokenizer.model", 24),
      voices: [
        { id: "alba", ...file("english_2026-01/voices/alba.safetensors", 16) },
        { id: "marius", ...file("english_2026-01/voices/marius.safetensors", 16) },
      ],
    },
    {
      name: "german_24l",
      label: "German, 24 layers",
      language: "de",
      layers: 24,
      default_voice: "juergen",
      default_temperature: 0.5,
      default_text: "Hallo Welt.",
      weights: file("german_24l/model.safetensors", 4000),
      tokenizer: file("german_24l/tokenizer.model", 24),
      voices: [{ id: "juergen", ...file("german_24l/voices/juergen.safetensors", 16) }],
    },
  ],
};
