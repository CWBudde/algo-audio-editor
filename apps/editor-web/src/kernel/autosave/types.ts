/** Worker-to-page autosave payloads; kept import-free for the shared message types. */

export interface AutosaveStatus {
  state: "idle" | "saving" | "saved" | "error";
  /** This window's session; it changes when the window adopts a recovered one. */
  sessionId?: string;
  savedAt?: number;
  /** Whether the saved snapshot holds unsaved changes worth recovering. */
  dirty?: boolean;
  error?: string;
}

export interface RecoverableSession {
  sessionId: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  savedAt: number;
  bytes: number;
}
