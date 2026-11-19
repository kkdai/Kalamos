import type { KeyBinding } from "@codemirror/view";

export interface FileCommandHandlers {
  onOpenFile: () => void | Promise<void>;
  onSaveFile: () => void | Promise<void>;
  onSaveFileAs: () => void | Promise<void>;
  onNewFile: () => void | Promise<void>;
}

export function createFileKeymap(handlers: FileCommandHandlers): KeyBinding[] {
  return [
    {
      key: "Mod-o",
      preventDefault: true,
      run: () => {
        void handlers.onOpenFile();
        return true;
      },
    },
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        void handlers.onSaveFile();
        return true;
      },
    },
    {
      key: "Mod-Shift-s",
      preventDefault: true,
      run: () => {
        void handlers.onSaveFileAs();
        return true;
      },
    },
    {
      key: "Mod-n",
      preventDefault: true,
      run: () => {
        void handlers.onNewFile();
        return true;
      },
    },
  ];
}

export function bindWindowShortcuts(
  target: Window | Document | HTMLElement,
  handlers: FileCommandHandlers,
): () => void {
  const listener = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onOpenFile();
    } else if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onSaveFile();
    } else if (key === "s" && event.shiftKey) {
      event.preventDefault();
      void handlers.onSaveFileAs();
    } else if (key === "n" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onNewFile();
    }
  };

  target.addEventListener("keydown", listener);
  return () => {
    target.removeEventListener("keydown", listener);
  };
}
