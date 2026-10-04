import { BrowserWindow, type IpcMainInvokeEvent } from "electron";

export function trustedWindow(event: IpcMainInvokeEvent, applicationURL: string) {
  const frame = event.senderFrame;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !frame || frame !== event.sender.mainFrame) throw new Error("Untrusted IPC sender");
  const source = new URL(frame.url);
  const application = new URL(applicationURL);
  if (source.protocol !== application.protocol || source.host !== application.host)
    throw new Error("Untrusted IPC origin");
  return win;
}
