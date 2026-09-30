"use client";

import { type ReactNode, useEffect } from "react";

/**
 * A modal sheet (docs/07). A client component on purpose: while open it listens for Escape on the document, so the key
 * closes it wherever the focus is. When an action removes the button that had focus (a decision card that disappears
 * once recorded), focus falls back to the page, outside the dialog, and Escape must still work.
 */
export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  if (!open) return null;
  return (
    // The backdrop is not a control: a click outside closes the sheet, Escape closes it from the keyboard, and the Close button does both.
    <div className="sheet-backdrop">
      <button type="button" className="sheet-backdrop-hit" aria-label="Close" onClick={onClose} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent", border: 0, padding: 0, cursor: "default" }} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title} style={{ position: "relative" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
          <h2>{props.title}</h2>
          {/* the design system's quiet button (Button in index.tsx), written out so this module does not import that file back */}
          <button type="button" className="btn quiet " onClick={onClose}>Close</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
