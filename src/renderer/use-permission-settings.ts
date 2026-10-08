/**
 * The host's Claude Code permission settings: the mode new chats start in, the rules saved by
 * project, and the models Auto is unavailable for. Loaded once, and again whenever the host says they
 * changed (`permissions.changed`). Main owns them; this is only a view.
 */
import { useEffect, useState } from "react";
import type { PermissionSettingsView } from "../shared/permissions.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { problemWords } from "./words.ts";

export interface PermissionSettings {
  settings: PermissionSettingsView | null;
  /** A newer view the caller got back from a change it made. */
  setSettings: (view: PermissionSettingsView) => void;
  error: string | null;
}

export function usePermissionSettings(): PermissionSettings {
  const [settings, setSettings] = useState<PermissionSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let version = 0;
    // Only the newest read lands: a slow answer never replaces a newer one.
    const load = (): void => {
      const mine = ++version;
      const latest = () => current && mine === version;
      void Promise.resolve()
        .then(() => window.studio.permissions())
        .then((view) => {
          if (!latest()) return;
          setSettings(view);
          setError(null);
        })
        .catch((cause) => {
          if (latest()) setError(problemWords(cause));
        });
    };
    load();
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.PermissionsChanged) load();
    });
    return () => {
      current = false;
      off();
    };
  }, []);
  return { settings, setSettings, error };
}
