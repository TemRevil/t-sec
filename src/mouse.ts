// Terminal mouse support. Ink has none, so this does it directly:
//
//  - Switches to the ALTERNATE SCREEN BUFFER. That matters for more than looks: a click
//    reports an ABSOLUTE screen row, so we can only map it back to a UI row if our frame
//    starts at a known place. On the alt screen the frame always starts at screen row 1.
//    (It also means the menu doesn't scroll away the user's shell history.)
//  - Enables SGR mouse reporting (1006). The older X10 encoding packs coordinates into
//    single bytes and breaks past column 223, which a wide terminal passes easily.
//
// Both are restored on exit - leaving either one on would wreck the user's shell.

export interface MouseEvent {
  x: number; // 1-based column
  y: number; // 1-based row
  button: number;
  pressed: boolean;
}

export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;
export const LEFT_BUTTON = 0;

let active = false;

export function enterFullscreenMouse(): void {
  if (active || !process.stdout.isTTY) return;
  active = true;
  // 1049 = alt screen, 1000 = report button presses, 1006 = SGR extended coordinates.
  process.stdout.write("\u001B[?1049h\u001B[?1000h\u001B[?1006h");
}

export function exitFullscreenMouse(): void {
  if (!active) return;
  active = false;
  process.stdout.write("\u001B[?1006l\u001B[?1000l\u001B[?1049l");
}

/** SGR mouse reports look like ESC [ < button ; col ; row M (press) or m (release). */
const SGR_MOUSE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;

export function parseMouseEvents(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  SGR_MOUSE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_MOUSE.exec(data)) !== null) {
    events.push({
      button: Number(m[1]),
      x: Number(m[2]),
      y: Number(m[3]),
      pressed: m[4] === "M",
    });
  }
  return events;
}

/** True if the chunk is (or contains) a mouse report rather than real typing. Ink's own key
 * parsing sees the same bytes; without this an incoming click could be read as a stray
 * Escape and navigate the user backwards on every click. */
export function looksLikeMouse(data: string): boolean {
  return data.includes("\u001B[<");
}

/** Turn reporting on/off without leaving the alternate screen. Used to silence the mouse
 * while a text field has focus - see stripMouseResidue for why that matters. */
export function setMouseReporting(on: boolean): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(on ? "\u001B[?1000h\u001B[?1006h" : "\u001B[?1006l\u001B[?1000l");
}

// Ink does not always hand a listener the whole chunk: it can split "\u001B[<0;30;12M" so the
// ESC arrives alone and "[<0;30;12M" follows as ordinary printable text - which then gets
// TYPED into whatever field has focus. Whole-chunk detection cannot catch that, so anything
// consuming keystrokes strips this residue too, with or without its leading ESC.
const MOUSE_RESIDUE = /\u001B?\[?<\d+;\d+;\d+[Mm]/g;

export function stripMouseResidue(text: string): string {
  return text.replace(MOUSE_RESIDUE, "");
}
