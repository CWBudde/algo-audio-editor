import { toast } from "sonner";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";

interface PlannedItem {
  label: string;
  shortcut?: string;
}

/** Menu entries that exist so the shell has its final shape; wired up in later phases. */
const PLANNED: Record<string, (PlannedItem | "-")[]> = {
  File: [
    { label: "New…", shortcut: "Ctrl+N" },
    { label: "Open…", shortcut: "Ctrl+O" },
    "-",
    { label: "Save", shortcut: "Ctrl+S" },
    { label: "Export…", shortcut: "Ctrl+Shift+E" },
  ],
  Edit: [
    { label: "Undo", shortcut: "Ctrl+Z" },
    { label: "Redo", shortcut: "Ctrl+Shift+Z" },
    "-",
    { label: "Cut", shortcut: "Ctrl+X" },
    { label: "Copy", shortcut: "Ctrl+C" },
    { label: "Paste", shortcut: "Ctrl+V" },
  ],
  Process: [{ label: "Amplify…" }, { label: "Normalize…" }, { label: "Fade In / Out" }],
  Effects: [{ label: "Equalizer…" }, { label: "Dynamics…" }, { label: "Reverb…" }],
  View: [
    { label: "Zoom In", shortcut: "Ctrl+=" },
    { label: "Zoom Out", shortcut: "Ctrl+-" },
    { label: "Zoom to Fit", shortcut: "Ctrl+0" },
    { label: "Zoom to Selection" },
  ],
};

interface AppMenubarProps {
  aboutText: string;
  onOpen?: () => void;
  onSave?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomFit?: () => void;
  onZoomSelection?: () => void;
}

export function AppMenubar({
  aboutText,
  onOpen,
  onSave,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onZoomSelection,
}: AppMenubarProps) {
  const actions: Record<string, (() => void) | undefined> = {
    "Open…": onOpen,
    Save: onSave,
    "Export…": onSave,
    "Zoom In": onZoomIn,
    "Zoom Out": onZoomOut,
    "Zoom to Fit": onZoomFit,
    "Zoom to Selection": onZoomSelection,
  };
  return (
    <Menubar className="h-8 rounded-none border-0 bg-transparent p-0 shadow-none">
      {Object.entries(PLANNED).map(([menu, items]) => (
        <MenubarMenu key={menu}>
          <MenubarTrigger>{menu}</MenubarTrigger>
          <MenubarContent>
            {items.map((item, i) =>
              item === "-" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list, separators have no identity
                <MenubarSeparator key={`sep-${i}`} />
              ) : (
                <MenubarItem
                  key={item.label}
                  disabled={!actions[item.label]}
                  onClick={actions[item.label]}
                >
                  {item.label}
                  {item.shortcut && <MenubarShortcut>{item.shortcut}</MenubarShortcut>}
                </MenubarItem>
              ),
            )}
          </MenubarContent>
        </MenubarMenu>
      ))}
      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onClick={() => toast("algo-audio-editor", { description: aboutText })}>
            About
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
