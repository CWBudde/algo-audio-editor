import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StatusBar } from "./status-bar";

afterEach(cleanup);

it("displays document sample storage with binary units once memory is known", () => {
  const { getByTestId, rerender } = render(<StatusBar kernel={{ status: "loading" }} />);
  expect(getByTestId("document-memory").textContent).toBe("–");

  rerender(
    <StatusBar
      kernel={{ status: "loading" }}
      memory={{ sampleBytes: 0, uniqueBlocks: 0, blockReferences: 0 }}
    />,
  );
  expect(getByTestId("document-memory").textContent).toBe("0 B");

  rerender(
    <StatusBar
      kernel={{ status: "loading" }}
      memory={{ sampleBytes: 1024 ** 2 * 1.5, uniqueBlocks: 96, blockReferences: 192 }}
    />,
  );
  expect(getByTestId("document-memory").textContent).toBe("1.5 MiB");
});
