import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WaveformPlaceholder } from "./waveform-placeholder";

afterEach(cleanup);

it("shows opened file metadata instead of the empty-document prompt", () => {
  const { getByTestId, queryByText } = render(
    <WaveformPlaceholder
      info={{
        name: "empty.wav",
        sampleRate: 44100,
        channels: 2,
        frames: 0,
        bitDepth: 32,
        float: true,
      }}
    />,
  );
  expect(getByTestId("document-name").textContent).toBe("empty.wav");
  expect(getByTestId("document-details").textContent).toContain(
    "44100 Hz · 2 channels · 0 frames · 0.000 s · 32-bit float",
  );
  expect(queryByText("No document open")).toBeNull();
});
