import {
  createContext, useCallback, useContext, useRef, useState, type ReactNode,
} from "react";

export interface DeskDoc {
  id: string;
  title: string;
  folder?: boolean;
  content: ReactNode;
  x: number;
  y: number;
  z: number;
}

interface DeskValue {
  docs: DeskDoc[];
  isMobile: boolean;
  open: (id: string, title: string, content: ReactNode, folder?: boolean) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
}

const DeskContext = createContext<DeskValue | null>(null);

export function DeskProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<DeskDoc[]>([]);
  const zTop = useRef(10);
  const opened = useRef(0);
  const isMobile =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 720px)").matches;

  const focus = useCallback((id: string) => {
    zTop.current += 1;
    const z = zTop.current;
    setDocs((d) => d.map((doc) => (doc.id === id ? { ...doc, z } : doc)));
  }, []);

  const open = useCallback(
    (id: string, title: string, content: ReactNode, folder?: boolean) => {
      setDocs((d) => {
        const existing = d.find((doc) => doc.id === id);
        zTop.current += 1;
        if (existing) {
          return d.map((doc) =>
            doc.id === id ? { ...doc, content, z: zTop.current } : doc,
          );
        }
        const offset = (opened.current % 6) * 26;
        opened.current += 1;
        return [
          ...d,
          { id, title, content, folder, x: 60 + offset, y: 40 + offset, z: zTop.current },
        ];
      });
    },
    [],
  );

  const close = useCallback((id: string) => {
    setDocs((d) => d.filter((doc) => doc.id !== id));
  }, []);

  const move = useCallback((id: string, x: number, y: number) => {
    setDocs((d) => d.map((doc) => (doc.id === id ? { ...doc, x, y } : doc)));
  }, []);

  return (
    <DeskContext.Provider value={{ docs, isMobile, open, close, focus, move }}>
      {children}
    </DeskContext.Provider>
  );
}

export function useDesk(): DeskValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used within DeskProvider");
  return ctx;
}
