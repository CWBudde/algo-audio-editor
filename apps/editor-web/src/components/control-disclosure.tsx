import { type ComponentProps, useEffect, useLayoutEffect, useRef } from "react";

function positionPanel(node: HTMLDetailsElement) {
  if (!node.open) return;
  const panel = node.querySelector<HTMLElement>("[data-disclosure-panel]");
  const summary = node.querySelector("summary");
  const view = node.ownerDocument.defaultView;
  if (!panel || !summary || !view) return;
  const anchor = summary.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.maxWidth = `${Math.max(0, view.innerWidth - 16)}px`;
  panel.style.maxHeight = "min(20rem, calc(100dvh - 1rem))";
  panel.style.overflowY = "auto";
  const bounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(anchor.left, view.innerWidth - bounds.width - 8))}px`;
  panel.style.right = "auto";
  const below = anchor.bottom + 4;
  panel.style.top = `${below + bounds.height <= view.innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 4)}px`;
}

/** Native keyboard-accessible disclosure with light-dismiss and Escape. */
export function ControlDisclosure(props: ComponentProps<"details">) {
  const details = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (details.current) positionPanel(details.current);
  });
  useEffect(() => {
    const node = details.current;
    if (!node) return;
    const owner = node.ownerDocument;
    const view = owner.defaultView;
    const align = () => positionPanel(node);
    const dismissOutside = (event: PointerEvent) => {
      if (node.open && event.target instanceof Node && !node.contains(event.target))
        node.open = false;
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !node.open ||
        !node.contains(owner.activeElement)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      node.open = false;
      node.querySelector("summary")?.focus();
    };
    owner.addEventListener("pointerdown", dismissOutside);
    owner.addEventListener("keydown", dismissEscape);
    owner.addEventListener("scroll", align, true);
    view?.addEventListener("resize", align);
    node.addEventListener("toggle", align);
    return () => {
      owner.removeEventListener("pointerdown", dismissOutside);
      owner.removeEventListener("keydown", dismissEscape);
      owner.removeEventListener("scroll", align, true);
      view?.removeEventListener("resize", align);
      node.removeEventListener("toggle", align);
    };
  }, []);
  return <details {...props} ref={details} name="editor-controls" />;
}
