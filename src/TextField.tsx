import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { looksLikeMouse, stripMouseResidue } from "./mouse.js";
import { readClipboard, writeClipboard } from "./clipboard.js";

// Replaces ink-text-input. Two reasons it had to go:
//
//  1. It types whatever bytes arrive. With mouse reporting on, every click delivered an
//     escape sequence that landed in the field as literal "[<0;93;21m..." garbage.
//     Anything reading raw input now has to filter mouse reports explicitly.
//  2. It has no selection, no clipboard and no word-delete, which the app needs.

/** Start of the word before `i` - skips trailing spaces, then eats one run of word chars
 * (UPPER_SNAKE_CASE counts as one word) or one run of punctuation. */
function prevWordBoundary(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1])) j--;
  if (j > 0 && /\w/.test(s[j - 1])) {
    while (j > 0 && /\w/.test(s[j - 1])) j--;
  } else {
    while (j > 0 && !/[\w\s]/.test(s[j - 1])) j--;
  }
  return j;
}

export interface TextFieldProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  /** Render every character as this glyph (secret entry). Copy still yields the real text. */
  mask?: string;
}

export default function TextField({ value, onChange, onSubmit, mask }: TextFieldProps) {
  const [cursor, setCursor] = useState(value.length);
  const [anchor, setAnchor] = useState<number | null>(null);

  const selStart = anchor === null ? null : Math.min(anchor, cursor);
  const selEnd = anchor === null ? null : Math.max(anchor, cursor);
  const hasSelection = selStart !== null && selEnd !== null && selEnd > selStart;

  function clampCursor(next: string, pos: number) {
    setCursor(Math.max(0, Math.min(pos, next.length)));
  }

  function replaceSelection(insert: string) {
    if (hasSelection) {
      const next = value.slice(0, selStart!) + insert + value.slice(selEnd!);
      onChange(next);
      clampCursor(next, selStart! + insert.length);
    } else {
      const next = value.slice(0, cursor) + insert + value.slice(cursor);
      onChange(next);
      clampCursor(next, cursor + insert.length);
    }
    setAnchor(null);
  }

  function selectedText(): string {
    return hasSelection ? value.slice(selStart!, selEnd!) : value;
  }

  useInput((input, key) => {
    // A click arrives as an escape sequence; without this it would be typed as text.
    if (looksLikeMouse(input)) return;

    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.ctrl) {
      const k = input.toLowerCase();
      if (k === "a") {
        setAnchor(0);
        setCursor(value.length);
        return;
      }
      // Ctrl+C is QUIT everywhere in this app, including here - the App's own handler does it,
      // so this one just declines to type anything. Copy moved to Ctrl+Shift+C, with Ctrl+Y as
      // the always-works alias: plenty of terminals send the identical control byte for Ctrl+C and
      // Ctrl+Shift+C, or swallow Ctrl+Shift+C as their own "copy selection", so `key.shift` is
      // only sometimes true here. The Copy action on a key's page is the dependable route.
      if (k === "c") {
        if (key.shift) writeClipboard(selectedText());
        return;
      }
      if (k === "y") {
        writeClipboard(selectedText());
        return;
      }
      if (k === "x") {
        writeClipboard(selectedText());
        if (hasSelection) {
          const next = value.slice(0, selStart!) + value.slice(selEnd!);
          onChange(next);
          clampCursor(next, selStart!);
        } else {
          onChange("");
          setCursor(0);
        }
        setAnchor(null);
        return;
      }
      if (k === "v") {
        // Strip newlines - a pasted multi-line blob would otherwise submit half a value.
        replaceSelection(readClipboard().replace(/\r?\n/g, ""));
        return;
      }
      // Ctrl+Backspace: terminals disagree wildly on what to send. Ink also decodes the
      // control BYTE back into a letter, so ctrl+w and ctrl+h arrive as LETTERS, not as
      // the raw bytes - comparing against those never matched. Accept every spelling.
      if (key.backspace || key.delete || k === "w" || k === "h") {
        const start = prevWordBoundary(value, cursor);
        const next = value.slice(0, start) + value.slice(cursor);
        onChange(next);
        clampCursor(next, start);
        setAnchor(null);
        return;
      }
      return;
    }

    if (key.leftArrow) {
      setAnchor(null);
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setAnchor(null);
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (hasSelection) {
        const next = value.slice(0, selStart!) + value.slice(selEnd!);
        onChange(next);
        clampCursor(next, selStart!);
        setAnchor(null);
      } else if (cursor > 0) {
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        onChange(next);
        clampCursor(next, cursor - 1);
      }
      return;
    }

    // Escape is the app's "go back" - leave it to the parent.
    if (key.escape || key.tab || key.upArrow || key.downArrow) return;

    // Anything else printable. Filter stray control bytes so a rogue sequence can't land
    // in the value the way the mouse reports used to.
    const printable = stripMouseResidue(input).replace(/[\u0000-\u001F\u007F]/g, "");
    if (printable) replaceSelection(printable);
  });

  const shown = mask ? mask.repeat(value.length) : value;

  function segment(text: string, key: string, inverse = false) {
    return (
      <Text key={key} inverse={inverse}>
        {text}
      </Text>
    );
  }

  return (
    <Box>
      {hasSelection ? (
        <>
          {segment(shown.slice(0, selStart!), "a")}
          {segment(shown.slice(selStart!, selEnd!), "b", true)}
          {segment(shown.slice(selEnd!), "c")}
        </>
      ) : (
        <>
          {segment(shown.slice(0, cursor), "a")}
          {segment(shown.slice(cursor, cursor + 1) || " ", "cur", true)}
          {segment(shown.slice(cursor + 1), "c")}
        </>
      )}
    </Box>
  );
}
