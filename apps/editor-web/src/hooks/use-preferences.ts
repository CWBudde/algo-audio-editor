import { useSyncExternalStore } from "react";
import {
  getPreferences,
  type Preferences,
  subscribePreferences,
  updatePreferences,
} from "@/lib/preferences";

/** Current persisted preferences; every view re-renders when one changes. */
export function usePreferences(): [Preferences, (change: Partial<Preferences>) => void] {
  return [useSyncExternalStore(subscribePreferences, getPreferences), updatePreferences];
}
