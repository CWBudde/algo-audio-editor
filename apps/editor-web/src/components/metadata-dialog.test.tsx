import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MetadataView } from "@/hooks/use-metadata";
import { MetadataDialog } from "./metadata-dialog";

const view: MetadataView = {
  name: "tone.wav",
  working: false,
  committing: false,
  metadata: {
    documentId: "doc",
    stateId: "state",
    tags: { title: "Imported", artist: "Artist" },
    chunks: ["LIST/INFO", "bext"],
    preservedBytes: 640,
  },
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(cleanup);
it("edits imported tags once, retains the draft through errors, and restores opener focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const commit = vi.fn(),
    cancel = vi.fn();
  const ui = render(<MetadataDialog view={view} onCancel={cancel} onCommit={commit} />);
  const title = ui.getByLabelText("Title") as HTMLInputElement;
  expect(document.activeElement).toBe(title);
  expect(title.value).toBe("Imported");
  expect(ui.getByText(/LIST\/INFO, bext/)).toBeTruthy();
  fireEvent.change(title, { target: { value: "Changed 🎵" } });
  ui.rerender(
    <MetadataDialog view={{ ...view, error: "Retry" }} onCancel={cancel} onCommit={commit} />,
  );
  expect(title.value).toBe("Changed 🎵");
  fireEvent.click(ui.getByRole("button", { name: "Apply metadata" }));
  expect(commit).toHaveBeenCalledWith({ title: "Changed 🎵", artist: "Artist" });
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(cancel).toHaveBeenCalledOnce();
  ui.rerender(<MetadataDialog onCancel={cancel} onCommit={commit} />);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
it("allows loading cancellation, fences submission during commit, and refreshes a new snapshot", () => {
  const cancel = vi.fn(),
    commit = vi.fn();
  const ui = render(
    <MetadataDialog
      view={{ name: "loading.wav", working: true, committing: false }}
      onCancel={cancel}
      onCommit={commit}
    />,
  );
  expect((ui.getByRole("button", { name: "Apply metadata" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  ui.rerender(
    <MetadataDialog
      view={{ ...view, working: true, committing: true }}
      onCancel={cancel}
      onCommit={commit}
    />,
  );
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  fireEvent.submit(
    ui.getByRole("button", { name: "Apply metadata" }).closest("form") as HTMLFormElement,
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  expect((ui.getByLabelText("Artist") as HTMLInputElement).disabled).toBe(true);
  ui.rerender(
    <MetadataDialog
      view={{
        ...view,
        metadata: {
          ...(view.metadata as NonNullable<MetadataView["metadata"]>),
          tags: { title: "New snapshot" },
        },
      }}
      onCancel={cancel}
      onCommit={commit}
    />,
  );
  expect((ui.getByLabelText("Title") as HTMLInputElement).value).toBe("New snapshot");
});
