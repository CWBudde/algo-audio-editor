import { randomUUID } from "node:crypto";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import type { DesktopState, NativeMenuItem } from "../../editor-web/src/platform";
import { trustedWindow } from "./ipc";
import { matchesAccelerator } from "./shortcuts";

function menuItems(value: unknown, win: BrowserWindow, depth = 0): MenuItemConstructorOptions[] {
  if (!Array.isArray(value) || value.length > 200 || depth > 3) throw new Error("Invalid menu");
  return value.map((item: NativeMenuItem) => {
    if (!item || typeof item !== "object") throw new Error("Invalid menu item");
    if (item.separator) return { type: "separator" };
    if (typeof item.label !== "string" || item.label.length > 160)
      throw new Error("Invalid menu label");
    if (item.children)
      return { label: item.label, submenu: menuItems(item.children, win, depth + 1) };
    if (
      typeof item.id !== "string" ||
      !/^[a-z][a-z0-9.-]{1,100}$/.test(item.id) ||
      typeof item.enabled !== "boolean" ||
      (item.accelerator !== undefined &&
        (typeof item.accelerator !== "string" || item.accelerator.length > 80))
    )
      throw new Error("Invalid command");
    return {
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      accelerator: item.accelerator,
      // Renderer shortcuts retain text-input, modal and repeat guards.
      registerAccelerator: false,
      click: () => {
        if (!win.isDestroyed()) win.webContents.send("desktop.command", item.id);
      },
    };
  });
}
export function registerDesktop(applicationURL: string, checkUpdates: () => void) {
  const states = new Map<number, DesktopState>();
  const menus = new Map<number, MenuItemConstructorOptions[]>();
  const closing = new Map<number, { request?: string; allow: boolean; pending: boolean }>();
  const applyMenu = (win: BrowserWindow) => {
    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      ...(menus.get(win.id) ?? []),
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { role: "togglefullscreen" },
          { role: "close" },
        ],
      },
      {
        label: "Application",
        submenu: [
          { label: "Check for updates…", enabled: app.isPackaged, click: checkUpdates },
          { role: "quit" },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  ipcMain.handle("desktop.menu", (event, items: unknown) => {
    const win = trustedWindow(event, applicationURL);
    menus.set(win.id, menuItems(items, win));
    if (win.isFocused() || BrowserWindow.getAllWindows().length === 1) applyMenu(win);
  });
  ipcMain.handle("desktop.state", (event, value: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const state = value as DesktopState;
    if (
      !state ||
      typeof state.dirty !== "boolean" ||
      typeof state.busy !== "boolean" ||
      (state.name !== undefined && (typeof state.name !== "string" || state.name.length > 255))
    )
      throw new Error("Invalid document state");
    states.set(win.id, { dirty: state.dirty, busy: state.busy, name: state.name });
    win.setDocumentEdited(state.dirty);
  });
  ipcMain.handle("desktop.confirm-replace", async (event, name: unknown) => {
    const win = trustedWindow(event, applicationURL);
    if (typeof name !== "string" || name.length > 255) throw new Error("Invalid document name");
    const result = await dialog.showMessageBox(win, {
      type: "question",
      message: `Discard changes to ${name}?`,
      detail: "The document has unsaved changes.",
      buttons: ["Cancel", "Discard"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  });
  ipcMain.handle("desktop.complete-close", (event, request: unknown, saved: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const state = closing.get(win.id);
    if (
      typeof request !== "string" ||
      typeof saved !== "boolean" ||
      !state ||
      state.request !== request
    )
      throw new Error("Invalid close response");
    state.request = undefined;
    state.pending = false;
    if (saved) {
      state.allow = true;
      win.close();
    }
  });
  return (win: BrowserWindow) => {
    const state = { allow: false, pending: false, request: undefined as string | undefined };
    closing.set(win.id, state);
    win.on("focus", () => applyMenu(win));
    if (process.platform === "darwin") {
      win.webContents.on("before-input-event", (_event, input) => {
        const matches = (items: MenuItemConstructorOptions[]): boolean =>
          items.some(
            (item) =>
              (typeof item.accelerator === "string" &&
                matchesAccelerator(item.accelerator, input)) ||
              (Array.isArray(item.submenu) && matches(item.submenu)),
          );
        // Retain native Quit/Window shortcuts while the renderer owns editor
        // bindings, including its text-field, IME, modal and repeat guards.
        win.webContents.setIgnoreMenuShortcuts(matches(menus.get(win.id) ?? []));
      });
    }
    win.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) {
        menus.delete(win.id);
        state.request = undefined;
        state.pending = false;
      }
    });
    win.on("closed", () => {
      states.delete(win.id);
      menus.delete(win.id);
      closing.delete(win.id);
    });
    win.on("close", (event) => {
      if (state.allow) return;
      const document = states.get(win.id);
      if (!document?.dirty && !document?.busy) return;
      event.preventDefault();
      if (state.pending) return;
      state.pending = true;
      void (async () => {
        if (document.busy) {
          await dialog.showMessageBox(win, {
            type: "info",
            message: "An operation is still in progress.",
            detail: "Finish or cancel it before closing the window.",
          });
          return;
        }
        const result = await dialog.showMessageBox(win, {
          type: "question",
          message: `Save changes to ${document.name ?? "Untitled"}?`,
          detail: "Unsaved changes will be lost if you close this window.",
          buttons: ["Save", "Discard", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (win.isDestroyed()) return;
        if (states.get(win.id) !== document) return;
        if (result.response === 1) {
          state.allow = true;
          win.close();
        } else if (result.response === 0) {
          state.request = randomUUID();
          win.webContents.send("desktop.save-close", state.request);
        }
      })()
        .catch((error) => {
          console.error("Could not close window", error);
        })
        .finally(() => {
          if (!state.request) state.pending = false;
        });
    });
    applyMenu(win);
  };
}
