import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import TextField from "./TextField.js";
import * as engine from "./engine.js";
import { writeClipboard } from "./clipboard.js";
import {
  LEFT_BUTTON,
  WHEEL_DOWN,
  WHEEL_UP,
  looksLikeMouse,
  parseMouseEvents,
  setMouseReporting,
} from "./mouse.js";

type Answers = Record<string, string>;

type Step =
  | { type: "text"; key: string; prompt: string; mask?: boolean; skip?: (a: Answers) => boolean }
  | {
      type: "select";
      key: string;
      prompt: string;
      options: (a: Answers) => { label: string; value: string }[];
      skip?: (a: Answers) => boolean;
    };

type Cell = { text: string; color?: string };
type Block = { kind: "text"; text: string } | { kind: "table"; headers: string[]; rows: Cell[][] };
type ActionResult = string | Block[];

interface Action {
  key: string;
  label: string;
  group: string;
  steps: Step[];
  run: (answers: Answers) => ActionResult;
  /** Screen to land on after the result/error screen closes, when neither the "key just
   * deleted" nor "project just deleted" fallback in backToPrevious applies. Actions launched
   * from the menu (no activeProject) don't need this - "menu" is the default. */
  after?: Screen;
}

const SECRET_MASK = "********";

function cell(text: string, color?: string): Cell {
  return { text, color };
}

/** Picker label - kept short so it doesn't wrap inside a field box. The added-date and the
 * full "this device" wording live in the devices TABLE; here a leading dot is enough. */
function deviceOptions() {
  const pk = engine.currentDevicePublicKey();
  return engine.readRecipients().map((d) => ({
    label: `${d.publicKey === pk ? "● " : "  "}${d.label}  [${engine.fingerprint(d.publicKey)}]`,
    value: engine.fingerprint(d.publicKey),
  }));
}

const YES_NO = [
  { label: "No", value: "n" },
  { label: "Yes", value: "y" },
];

/** legCell/conflictNote mirror cli.tsx's plain-text formatting, just with Ink's color cells
 * instead of ANSI-free strings - keep the two in sync if the status shape changes. */
function legCell(leg: engine.LegStatus): Cell {
  if (leg.kind === "unconfigured") return cell("-", "gray");
  if (leg.kind === "not-git-tracked") return cell("not git-tracked", "gray");
  if (leg.kind === "error") return cell(`error: ${leg.message}`, "red");
  if (leg.ahead === 0 && leg.behind === 0) return cell("in sync", "green");
  const base = `+${leg.ahead}/-${leg.behind}`;
  if (leg.conflicts === undefined) return cell(base, "yellow");
  if (leg.conflicts === "unknown") return cell(`${base} (conflicts: unknown)`, "yellow");
  return leg.conflicts.length === 0
    ? cell(`${base} (clean merge)`, "yellow")
    : cell(`${base} (${leg.conflicts.length} would conflict)`, "red");
}

function repoStatusResult(project: string): ActionResult {
  const r = engine.repoStatus(project);
  if (r.local.kind === "error") return `local: error - ${r.local.message}`;
  const rows: Cell[][] = [
    [cell("local"), cell(`${r.local.branch}@${r.local.commit.slice(0, 10)}`)],
    [cell("github"), legCell(r.github)],
    [cell("vps"), legCell(r.vps)],
  ];
  const fileList = (leg: engine.LegStatus) => (leg.kind === "ok" && leg.files.length > 0 ? leg.files : []);
  const notes = [...fileList(r.github), ...fileList(r.vps)];
  const blocks: Block[] = [{ kind: "table", headers: ["Surface", "Status"], rows }];
  if (notes.length > 0) {
    blocks.push({ kind: "text", text: `\n${notes.length} file(s) differ - see 'repo-status ${project}' on the command line for the full list.` });
  }
  return blocks;
}

function reencryptResult(): ActionResult {
  const results = engine.reencryptAll();
  if (!results.length) return "(no secrets stored yet)";
  return [
    {
      kind: "table",
      headers: ["Project", "Status"],
      rows: results.map((r) => [cell(r.project), r.ok ? cell("✓ ok", "green") : cell(`✗ FAIL: ${r.error}`, "red")]),
    },
  ];
}

function buildDeviceActions(): Action[] {
  return [
    {
      key: "whoami",
      label: "Show which device I'm on",
      group: "Device",
      steps: [],
      run: () => {
        const { publicKey, device } = engine.whoami();
        if (!publicKey) {
          return "This device has no identity yet - it is NOT trusted.\nUse 'Add / trust this device' to fix that.";
        }
        const label = device ? device.label : "(identity exists but missing from recipients.txt)";
        return `Fingerprint: ${engine.fingerprint(publicKey)}\nLabel: ${label}\nTrusted: ${device ? "yes" : "no"}`;
      },
    },
    {
      key: "trust",
      label: "Add / trust this device",
      group: "Device",
      steps: [{ type: "text", key: "label", prompt: "Label for this device (blank = default):" }],
      run: (a) => {
        const { publicKey, alreadyTrusted, othersExisted } = engine.trustThisDevice(
          a.label?.trim() || undefined,
        );
        if (alreadyTrusted) {
          return `Already trusted.\nFingerprint: ${engine.fingerprint(publicKey)}`;
        }
        let msg = `Trusted this device.\nFingerprint: ${engine.fingerprint(publicKey)}`;
        if (othersExisted) {
          msg +=
            "\n\nOther devices already exist. This device CANNOT decrypt existing secrets " +
            "yet - go to an ALREADY-TRUSTED device and run Re-encrypt from its menu.";
        }
        return msg;
      },
    },
    {
      key: "devices",
      label: "List trusted devices",
      group: "Device",
      steps: [],
      run: () => {
        const pk = engine.currentDevicePublicKey();
        const devices = engine.readRecipients();
        if (!devices.length) return "No trusted devices yet.";
        return [
          {
            kind: "table",
            headers: ["Fingerprint", "Label", "Added", ""],
            rows: devices.map((d) => [
              cell(engine.fingerprint(d.publicKey)),
              cell(d.label),
              cell(d.added),
              d.publicKey === pk ? cell("●", "green") : cell(""),
            ]),
          },
        ];
      },
    },
    {
      key: "rename",
      label: "Rename a device",
      group: "Device",
      steps: [
        { type: "select", key: "target", prompt: "Rename which device?", options: deviceOptions },
        { type: "text", key: "newLabel", prompt: "New label:" },
      ],
      run: (a) => {
        const d = engine.renameDevice(a.target, a.newLabel.trim());
        return `Renamed to "${d.label}".`;
      },
    },
    {
      key: "remove",
      label: "Remove a device",
      group: "Device",
      steps: [
        { type: "select", key: "target", prompt: "Remove which device?", options: deviceOptions },
        { type: "select", key: "confirmed", prompt: "Remove this device?", options: () => YES_NO },
      ],
      run: (a) => {
        if (a.confirmed !== "y") return "Cancelled.";
        const removed = engine.removeDevice(a.target);
        try {
          const results = engine.reencryptAll();
          const blocks: Block[] = [{ kind: "text", text: `Removed "${removed.label}".` }];
          if (results.length) {
            blocks.push({
              kind: "table",
              headers: ["Project", "Status"],
              rows: results.map((r) => [cell(r.project), r.ok ? cell("✓ ok", "green") : cell(`✗ FAIL: ${r.error}`, "red")]),
            });
          }
          return blocks;
        } catch (e) {
          return `Removed "${removed.label}".\nCould not auto re-encrypt (${(e as Error).message}) - run Re-encrypt from a trusted device.`;
        }
      },
    },
    {
      key: "reencrypt",
      label: "Re-encrypt all secrets for current device list",
      group: "Device",
      steps: [],
      run: reencryptResult,
    },
  ];
}

function buildSettingsActions(): Action[] {
  return [
    {
      key: "install-path",
      label: "Install t-sec on this device's PATH",
      group: "Settings",
      steps: [],
      run: () => {
        const { status, scriptsDir, removedStale } = engine.installOnPath();
        const lines = removedStale.map((s) => `Removed stale PATH entry: ${s}`);
        if (status === "unsupported") {
          lines.push(`Not supported on this OS - add "${scriptsDir}" to PATH manually.`);
        } else if (status === "already-installed") {
          lines.push(`Already on PATH: ${scriptsDir}`);
        } else {
          lines.push(`Added to PATH: ${scriptsDir}`);
          lines.push("Open a new terminal for it to take effect.");
        }
        return lines.join("\n");
      },
    },
    {
      key: "selftest",
      label: "Run self-test (round-trips dummy data, touches no real secret)",
      group: "Settings",
      steps: [],
      run: () => {
        engine.selftest();
        return "Self-test passed - encrypt/decrypt round-trip is healthy.";
      },
    },
  ];
}

/** Adding a key: reached from the "➕ Add a key" row at the END of a project's key list, the
 * same way "➕ New project" sits after the project list. */
function removeProjectAction(project: string): Action {
  return {
    key: "remove-project",
    label: "🗑 Remove project",
    group: "",
    steps: [{ type: "select", key: "confirmed", prompt: `Delete "${project}" and ALL its secrets? No undo.`, options: () => YES_NO }],
    run: (a) => {
      if (a.confirmed !== "y") return "Cancelled.";
      engine.removeProject(project);
      return `Deleted project "${project}".`;
    },
    after: "project-menu",
  };
}

function addKeyAction(project: string): Action {
  return {
    key: "add-key",
    label: "➕ Add a key",
    group: "",
    steps: [
      { type: "text", key: "key", prompt: "Key name (UPPER_SNAKE_CASE):" },
      { type: "text", key: "value", prompt: "Value:", mask: true },
    ],
    run: (a) => {
      engine.setSecret(project, a.key.trim(), a.value);
      return `Saved ${a.key.trim()} in "${project}".`;
    },
    after: "project-detail",
  };
}

/** What you can do to ONE already-chosen key. Picking the key first (rather than picking an
 * action and then being asked which key) means the key is never re-selected. */
function keyActions(project: string, key: string): Action[] {
  return [
    {
      key: "view",
      label: "View value",
      group: "",
      steps: [],
      run: () => engine.getSecret(project, key),
    },
    {
      // The dependable copy. Ctrl+Shift+C only reaches us in terminals that bother to send a
      // distinguishable sequence for it, so the guaranteed route is a row you can click.
      key: "copy",
      label: "Copy value to clipboard",
      group: "",
      steps: [],
      run: () => {
        const ok = writeClipboard(engine.getSecret(project, key));
        return ok
          ? `Copied ${key} to the clipboard.\n\nIt is now plaintext in the OS clipboard - paste it where you need it, then copy something else.`
          : `Could not reach the clipboard. Use "View value" instead.`;
      },
    },
    {
      key: "update",
      label: "Update value",
      group: "",
      steps: [{ type: "text", key: "value", prompt: `New value for ${key}:`, mask: true }],
      run: (a) => {
        engine.setSecret(project, key, a.value);
        return `Updated ${key} in "${project}".`;
      },
    },
    {
      key: "remove-key",
      label: "Delete key",
      group: "",
      steps: [
        { type: "select", key: "confirmed", prompt: `Delete ${key}?`, options: () => YES_NO },
      ],
      run: (a) => {
        if (a.confirmed !== "y") return "Cancelled.";
        engine.removeSecret(project, key);
        return `Deleted "${key}" from "${project}".`;
      },
    },
  ];
}

/** Next step index in `direction` (+1 or -1) that isn't skipped, or out of bounds if none. */
function stepIndexInDirection(steps: Step[], from: number, answers: Answers, direction: 1 | -1): number {
  let i = from + direction;
  while (i >= 0 && i < steps.length && steps[i].skip?.(answers)) i += direction;
  return i;
}

function visibleSteps(steps: Step[], answers: Answers): number {
  return steps.filter((s) => !s.skip?.(answers)).length;
}

function visiblePosition(steps: Step[], index: number, answers: Answers): number {
  return steps.slice(0, index + 1).filter((s) => !s.skip?.(answers)).length;
}

function termWidth(): number {
  return process.stdout.columns || 80;
}

/** Trims from the FRONT (a path's tail is the informative half) so a long vault path can't
 * wrap and break the centering of everything under it. */
function ellipsizeStart(text: string, max: number): string {
  if (max < 4 || text.length <= max) return text;
  return "..." + text.slice(-(max - 3));
}

function Footer({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

/** Horizontally centers its children within the terminal's current width. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="column" alignItems="center" width={termWidth()}>
      {children}
    </Box>
  );
}

/** Small persistent brand mark shown above EVERY screen, so there's a consistent anchor
 * wherever you are in the app. */
function Breadcrumb() {
  return <Text dimColor>🔐 t-sec</Text>;
}

type PanelTone = "normal" | "destructive" | "error" | "success";

const PANEL_COLOR: Record<PanelTone, string> = {
  normal: "cyan",
  destructive: "yellow",
  error: "red",
  success: "green",
};

const PANEL_ICON: Record<PanelTone, string> = {
  normal: "",
  destructive: "⚠ ",
  error: "✗ ",
  success: "✓ ",
};

/** A titled, bordered card - the "screen" unit for EVERY screen, menu included. */
function Panel({
  title,
  subtitle,
  tone = "normal",
  width,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: PanelTone;
  width?: number;
  children: React.ReactNode;
}) {
  const color = PANEL_COLOR[tone];
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <Text bold color={color}>
        {PANEL_ICON[tone]}
        {title}
      </Text>
      {subtitle && <Text dimColor>{ellipsizeStart(subtitle, termWidth() - 4)}</Text>}
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={2}
        paddingY={1}
        // An explicit width is passed where clicks must be mapped to columns (the menu's tab
        // strip); elsewhere minWidth just stops a short result collapsing into a tiny box.
        width={width}
        minWidth={width ? undefined : Math.min(PANEL_MIN_WIDTH, termWidth() - 4)}
      >
        {children}
      </Box>
    </Box>
  );
}

/** Menu card width. Fixed rather than content-sized because the tab strip's hit-boxes are
 * derived from where the card starts, which needs the width up front. */
function menuCardWidth(tabs: Tab[]): number {
  const longestItem = Math.max(
    0,
    ...tabs.flatMap((t) => t.items.map((i) => i.label.length)),
  );
  const tabStripWidth = layoutTabs(tabs, 0).totalWidth;
  const desired = Math.max(PANEL_MIN_WIDTH, longestItem + 8, tabStripWidth + 8);
  return Math.min(desired, Math.max(20, termWidth() - 4));
}

const FIELD_WIDTH = 44;
const PANEL_MIN_WIDTH = 52;

/** A labelled section: its label sitting above its own boxed content. Used for every input in
 * a wizard AND for each block on the project page, so both read the same way. Omit `width` to
 * size to content (tables), pass one for a form field's fixed-width look. */
function Field({
  label,
  width,
  marginTop = 0,
  children,
}: {
  label: string;
  width?: number;
  marginTop?: number;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Text bold>{label}</Text>
      <Box borderStyle="round" borderColor="gray" paddingX={1} width={width}>
        {children}
      </Box>
    </Box>
  );
}

function StepDots({ total, position }: { total: number; position: number }) {
  if (total <= 1) return null;
  const dots = Array.from({ length: total }, (_, i) => (i === position - 1 ? "●" : "○")).join(" ");
  return (
    <Box marginBottom={1}>
      <Text color="cyan">{dots}</Text>
      <Text dimColor>
        {"  Step "}
        {position} of {total}
      </Text>
    </Box>
  );
}

/** A plain markdown-style table (pipes + a dash separator row), with optional per-cell color -
 * Ink has no table primitive, and coloring one cell rules out building rows as one padded string. */
function Table({ headers, rows }: { headers: string[]; rows: Cell[][] }) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i]?.text ?? "").length)));

  function Row({ cells, bold }: { cells: (string | Cell)[]; bold: boolean }) {
    return (
      <Box>
        <Text dimColor>{"| "}</Text>
        {cells.map((raw, i) => {
          const c: Cell = typeof raw === "string" ? { text: raw } : raw;
          return (
            <React.Fragment key={i}>
              <Box width={widths[i]}>
                <Text bold={bold} color={c.color}>
                  {c.text}
                </Text>
              </Box>
              <Text dimColor>{i < widths.length - 1 ? " | " : " |"}</Text>
            </React.Fragment>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Row cells={headers} bold />
      <Text dimColor>{"|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|"}</Text>
      {rows.map((r, i) => (
        <Row key={i} cells={r} bold={false} />
      ))}
    </Box>
  );
}

function ResultBody({ result }: { result: ActionResult }) {
  const blocks: Block[] = typeof result === "string" ? [{ kind: "text", text: result }] : result;
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) =>
        b.kind === "text" ? (
          <Text key={i}>{b.text}</Text>
        ) : (
          <Box key={i} marginTop={i === 0 ? 0 : 1}>
            <Table headers={b.headers} rows={b.rows} />
          </Box>
        ),
      )}
    </Box>
  );
}

interface Tab {
  key: string;
  label: string;
  icon: string;
  color: string;
  items: { label: string; value: string }[];
}

/** The three top-level sections, as left/right tabs. Projects lists real project names (read
 * live each render) so picking one drills straight into it. */
function buildTabs(topActions: Action[]): Tab[] {
  return [
    {
      key: "device",
      label: "Device",
      icon: "🖥",
      color: "blue",
      items: topActions
        .filter((a) => a.group === "Device")
        .map((a) => ({ label: a.label, value: `action:${a.key}` })),
    },
    {
      key: "projects",
      label: "Projects",
      icon: "📁",
      color: "green",
      items: [
        ...engine.listProjects().map((p) => ({ label: p, value: `project:${p}` })),
        { label: "➕ New project", value: "new-project" },
      ],
    },
    {
      key: "settings",
      label: "Settings",
      icon: "⚙",
      color: "yellow",
      items: [
        ...topActions
          .filter((a) => a.group === "Settings")
          .map((a) => ({ label: a.label, value: `action:${a.key}` })),
        { label: "Exit", value: "__exit__" },
      ],
    },
  ];
}

/** Rendered tab strip plus the x-ranges each tab occupies, so a click can be mapped back to
 * the tab it landed on. Built in one place so the drawing and the hit-testing can't drift. */
function layoutTabs(tabs: Tab[], startX: number) {
  const SEP = "  │  ";
  const segments: { tab: Tab; text: string; x1: number; x2: number }[] = [];
  let x = startX;
  tabs.forEach((t, i) => {
    if (i > 0) x += SEP.length;
    const text = `${t.icon} ${t.label}`;
    // Emoji render two columns wide but count as one JS char - correct for that so later
    // tabs' hit-boxes don't drift left of what's drawn.
    const drawnWidth = text.length + 1;
    segments.push({ tab: t, text, x1: x, x2: x + drawnWidth - 1 });
    x += drawnWidth;
  });
  return { segments, separator: SEP, totalWidth: x - startX };
}

function TabBar({ tabs, activeIndex, startX }: { tabs: Tab[]; activeIndex: number; startX: number }) {
  const { segments, separator } = layoutTabs(tabs, startX);
  return (
    <Box>
      {segments.map((seg, i) => (
        <React.Fragment key={seg.tab.key}>
          {i > 0 && <Text dimColor>{separator}</Text>}
          <Text
            bold={i === activeIndex}
            color={i === activeIndex ? seg.tab.color : undefined}
            dimColor={i !== activeIndex}
            underline={i === activeIndex}
          >
            {seg.text}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

/** One list style for the whole app - menu items, project actions and every wizard choice.
 * Replaces ink-select-input so keyboard and mouse behave identically everywhere (that
 * package has no click support and no way to report where its rows landed). */
function SelectList({
  items,
  cursor,
  color = "cyan",
}: {
  items: { label: string; value: string }[];
  cursor: number;
  color?: string;
}) {
  if (items.length === 0) {
    return <Text dimColor>(nothing to choose from - press Esc to go back)</Text>;
  }
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item.value} color={i === cursor ? color : undefined} bold={i === cursor}>
          {i === cursor ? "❯ " : "  "}
          {item.label}
        </Text>
      ))}
    </Box>
  );
}

type Screen = "menu" | "new-project" | "project-menu" | "project-detail" | "key-detail" | "steps" | "result" | "error";

function actionTone(action: Action): PanelTone {
  return action.key === "remove" || action.key === "remove-key" || action.key === "remove-project"
    ? "destructive"
    : "normal";
}


/** A clickable row: the frame row it occupies, and what to do when it's clicked. Rows span
 * the full terminal width (clicking anywhere on a line picks it) except tabs, which need an
 * x-range because three of them share one row. */
interface HitRegion {
  y: number;
  x1?: number;
  x2?: number;
  onClick: () => void;
}

// Frame geometry. Every screen stacks the same way, so a row index can be derived rather
// than measured - see LAYOUT_NOTE in the README. Row 0 is the breadcrumb because the app
// runs on the alternate screen, where our frame always starts at the top.
const ROW_BREADCRUMB = 0;
const ROW_TITLE = 2;
/** First content row inside the card. Counting down from the title: [subtitle], the card's
 * marginTop blank, its top border, its paddingY row - then content. Verified against the
 * real frame by uitest (see README); if the layout shifts, that check fails loudly. */
function cardContentRow(hasSubtitle: boolean): number {
  return ROW_TITLE + (hasSubtitle ? 1 : 0) + 4;
}


export default function App() {
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const [topActions] = useState(() => [...buildDeviceActions(), ...buildSettingsActions()]);
  const [screen, setScreen] = useState<Screen>("menu");
  const [current, setCurrent] = useState<Action | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [output, setOutput] = useState<ActionResult>("");
  const [resultTone, setResultTone] = useState<PanelTone>("success");
  const [textValue, setTextValue] = useState("");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [newProjectValue, setNewProjectValue] = useState("");
  const [newProjectError, setNewProjectError] = useState("");

  // One cursor per screen, deliberately NOT reset when you drill in. Going back therefore
  // lands on the row you left from instead of jumping to the top of the list.
  const [tabIndex, setTabIndex] = useState(0);
  const [tabCursors, setTabCursors] = useState<number[]>([0, 0, 0]);
  const [projectMenuCursor, setProjectMenuCursor] = useState(0);
  const [projectCursor, setProjectCursor] = useState(0);
  const [keyCursor, setKeyCursor] = useState(0);
  const [stepCursor, setStepCursor] = useState(0);

  const regionsRef = useRef<HitRegion[]>([]);
  const regions: HitRegion[] = [];

  const tabs = buildTabs(topActions);
  const activeTab = tabs[Math.min(tabIndex, tabs.length - 1)];

  function setMenuCursor(next: number) {
    setTabCursors((cs) => cs.map((c, i) => (i === tabIndex ? next : c)));
  }

  function beginAction(action: Action) {
    setCurrent(action);
    setAnswers({});
    setTextValue("");
    setStepCursor(0);
    const first = stepIndexInDirection(action.steps, -1, {}, 1);
    if (first >= action.steps.length) {
      runNow(action, {});
    } else {
      setStepIndex(first);
      setScreen("steps");
    }
  }

  function runNow(action: Action, finalAnswers: Answers) {
    try {
      const result = action.run(finalAnswers);
      setOutput(result);
      setResultTone("success");
      setScreen("result");
    } catch (e) {
      setOutput((e as Error).message);
      setScreen("error");
    }
  }

  function submitStep(value: string) {
    if (!current) return;
    const step = current.steps[stepIndex];
    const nextAnswers = { ...answers, [step.key]: value };
    setAnswers(nextAnswers);
    setTextValue("");
    setStepCursor(0);
    const next = stepIndexInDirection(current.steps, stepIndex, nextAnswers, 1);
    if (next < current.steps.length) {
      setStepIndex(next);
    } else {
      runNow(current, nextAnswers);
    }
  }

  /** Where "back" lands: the key's page if we were working on a key, else wherever the action
   * that just ran declared as its home (Action.after), else the menu. */
  function backToPrevious() {
    const after = current?.after ?? "menu";
    setCurrent(null);
    if (activeKey !== null) {
      // A deleted key can't have a page any more - fall back to its container, the secrets list.
      const stillThere = activeProject ? engine.listKeys(activeProject).includes(activeKey) : false;
      if (stillThere) {
        setScreen("key-detail");
        return;
      }
      setActiveKey(null);
      setScreen("project-detail");
      return;
    }
    if (activeProject !== null && !engine.listProjects().includes(activeProject)) {
      // A removed project can't have a page any more - fall back to the menu.
      setActiveProject(null);
      setScreen("menu");
      return;
    }
    setScreen(after);
  }

  function handleMenuSelect(value: string) {
    if (value === "__exit__") {
      exit();
      return;
    }
    if (value === "new-project") {
      setNewProjectValue("");
      setNewProjectError("");
      setScreen("new-project");
      return;
    }
    if (value.startsWith("project:")) {
      setActiveProject(value.slice("project:".length));
      setActiveKey(null);
      setProjectMenuCursor(0);
      setScreen("project-menu");
      return;
    }
    const action = topActions.find((a) => a.key === value.slice("action:".length));
    if (action) beginAction(action);
  }

  function submitNewProject(value: string) {
    const trimmed = value.trim();
    if (!engine.isValidProjectName(trimmed)) {
      setNewProjectError('Invalid name - use letters, numbers, spaces, "_", "-", "." only.');
      return;
    }
    setActiveProject(trimmed);
    setActiveKey(null);
    setProjectMenuCursor(0);
    setNewProjectValue("");
    setNewProjectError("");
    setScreen("project-menu");
  }

  function goBack() {
    if (screen === "result" || screen === "error") {
      backToPrevious();
      return;
    }
    if (screen === "new-project") {
      setScreen("menu");
      return;
    }
    if (screen === "key-detail") {
      setActiveKey(null);
      setScreen("project-detail");
      return;
    }
    if (screen === "project-detail") {
      setScreen("project-menu");
      return;
    }
    if (screen === "project-menu") {
      setActiveProject(null);
      setScreen("menu");
      return;
    }
    if (screen !== "steps" || !current) return;
    const prev = stepIndexInDirection(current.steps, stepIndex, answers, -1);
    if (prev < 0) {
      backToPrevious();
    } else {
      setTextValue("");
      setStepCursor(0);
      setStepIndex(prev);
    }
  }

  const currentStep = screen === "steps" && current ? current.steps[stepIndex] : null;
  const stepOptions = currentStep?.type === "select" ? currentStep.options(answers) : [];
  const isTyping = currentStep?.type === "text" || screen === "new-project";

  const projectKeys =
    activeProject && (screen === "project-menu" || screen === "project-detail" || screen === "key-detail")
      ? engine.listKeys(activeProject)
      : [];
  /** Project menu rows: project-level actions - repo status only if there's a local checkout
   * to compare (shells out to git/ssh, so it's a row you pick, not something computed on every
   * project open), the secrets drill-in, then remove, always last since it's destructive. */
  const projectMenuRows = [
    ...(projectKeys.includes("LOCAL_REPO_PATH") ? [{ label: "📊 Repo status", value: "repo-status" }] : []),
    { label: `🔑 Secrets (${projectKeys.length})`, value: "secrets" },
    { label: "🗑 Remove project", value: "remove-project" },
  ];
  /** Secrets page rows: every key, then the add-a-key row. */
  const projectRows = [
    ...projectKeys.map((k) => ({ label: k, value: `key:${k}` })),
    { label: "➕ Add a key", value: "add-key" },
  ];
  const currentKeyActions =
    screen === "key-detail" && activeProject && activeKey ? keyActions(activeProject, activeKey) : [];

  function openProjectMenuRow(value: string) {
    if (!activeProject) return;
    if (value === "secrets") {
      setProjectCursor(0);
      setScreen("project-detail");
      return;
    }
    if (value === "remove-project") {
      beginAction(removeProjectAction(activeProject));
      return;
    }
    if (value === "repo-status") {
      const project = activeProject;
      beginAction({
        key: "repo-status",
        label: "Repo status",
        group: "Project",
        steps: [],
        after: "project-menu",
        run: () => repoStatusResult(project),
      });
    }
  }

  function openProjectRow(value: string) {
    if (!activeProject) return;
    if (value === "add-key") {
      beginAction(addKeyAction(activeProject));
      return;
    }
    setActiveKey(value.slice("key:".length));
    setKeyCursor(0);
    setScreen("key-detail");
  }

  /** The list the arrows currently drive, with its own cursor. */
  function activeList() {
    if (screen === "menu") {
      const cur = Math.min(tabCursors[tabIndex] ?? 0, Math.max(0, activeTab.items.length - 1));
      return { items: activeTab.items, cursor: cur, setCursor: setMenuCursor, pick: handleMenuSelect };
    }
    if (screen === "project-menu") {
      return {
        items: projectMenuRows,
        cursor: Math.min(projectMenuCursor, Math.max(0, projectMenuRows.length - 1)),
        setCursor: setProjectMenuCursor,
        pick: openProjectMenuRow,
      };
    }
    if (screen === "project-detail") {
      return {
        items: projectRows,
        cursor: Math.min(projectCursor, Math.max(0, projectRows.length - 1)),
        setCursor: setProjectCursor,
        pick: openProjectRow,
      };
    }
    if (screen === "key-detail") {
      return {
        items: currentKeyActions.map((a) => ({ label: a.label, value: a.key })),
        cursor: Math.min(keyCursor, Math.max(0, currentKeyActions.length - 1)),
        setCursor: setKeyCursor,
        pick: (v: string) => {
          const action = currentKeyActions.find((a) => a.key === v);
          if (action) beginAction(action);
        },
      };
    }
    if (screen === "steps" && currentStep?.type === "select") {
      return {
        items: stepOptions,
        cursor: Math.min(stepCursor, Math.max(0, stepOptions.length - 1)),
        setCursor: setStepCursor,
        pick: submitStep,
      };
    }
    return null;
  }

  const list = activeList();

  function moveCursor(delta: number) {
    if (!list || list.items.length === 0) return;
    list.setCursor((list.cursor + delta + list.items.length) % list.items.length);
  }

  useInput((input, key) => {
    if (looksLikeMouse(input)) return;
    if (key.escape) {
      goBack();
      return;
    }
    // Ctrl+C quits from ANYWHERE, mid-typing included - checked before handing the keyboard
    // to TextField. Shift excluded so a terminal that does distinguish Ctrl+Shift+C sends it
    // through to TextField as copy instead of killing the app.
    if (key.ctrl && !key.shift && input.toLowerCase() === "c") {
      exit();
      return;
    }

    // While typing, TextField owns every other key.
    if (isTyping) return;

    if (screen === "menu" && (key.leftArrow || key.rightArrow)) {
      setTabIndex((i) => (i + (key.rightArrow ? 1 : -1) + tabs.length) % tabs.length);
      return;
    }
    if (key.upArrow) return moveCursor(-1);
    if (key.downArrow) return moveCursor(1);
    if (key.return) {
      if (screen === "result" || screen === "error") backToPrevious();
      else if (list && list.items.length) list.pick(list.items[list.cursor].value);
      return;
    }
    if (key.backspace || key.delete) {
      goBack();
      return;
    }
    if (input === "q") exit();
  });

  // Mouse: parse SGR reports off stdin and match them against rows registered last render.
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const text = String(data);
      if (!looksLikeMouse(text)) return;
      for (const ev of parseMouseEvents(text)) {
        if (!ev.pressed) continue;
        if (ev.button === WHEEL_UP) {
          moveCursor(-1);
          continue;
        }
        if (ev.button === WHEEL_DOWN) {
          moveCursor(1);
          continue;
        }
        if (ev.button !== LEFT_BUTTON) continue;
        const frameY = ev.y - 1; // alt screen: screen row 1 is our frame row 0
        const frameX = ev.x - 1;
        const hit = regionsRef.current.find(
          (r) => r.y === frameY && (r.x1 === undefined || (frameX >= r.x1 && frameX <= (r.x2 ?? r.x1))),
        );
        hit?.onClick();
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  });

  // Silence the mouse entirely while a text field has focus. Stripping the residue (see
  // stripMouseResidue) is the backstop; not emitting it at all is the actual fix.
  useEffect(() => {
    setMouseReporting(!isTyping);
  }, [isTyping]);

  useEffect(() => {
    setRawMode?.(true);
    return () => setRawMode?.(false);
  }, [setRawMode]);

  useEffect(() => {
    regionsRef.current = regions;
  });

  /** Registers one clickable row per list item, starting at `top`. */
  function registerRows(top: number, count: number, onPick: (i: number) => void) {
    for (let i = 0; i < count; i++) {
      regions.push({ y: top + i, onClick: () => onPick(i) });
    }
  }

  if (screen === "menu") {
    const cardWidth = menuCardWidth(tabs);
    const cardLeft = Math.max(0, Math.floor((termWidth() - cardWidth) / 2));
    const tabsStartX = cardLeft + 1 + 2; // border + paddingX
    const { segments } = layoutTabs(tabs, tabsStartX);
    const contentTop = cardContentRow(true);
    const menuCursor = list ? list.cursor : 0;

    segments.forEach((seg, i) => {
      regions.push({ y: contentTop, x1: seg.x1, x2: seg.x2, onClick: () => setTabIndex(i) });
    });
    registerRows(contentTop + 2, activeTab.items.length, (i) => {
      setMenuCursor(i);
      handleMenuSelect(activeTab.items[i].value);
    });

    return (
      <Centered>
        <Breadcrumb />
        <Panel title="t-sec secrets" subtitle={engine.VAULT_ROOT} width={cardWidth}>
          <TabBar tabs={tabs} activeIndex={tabIndex} startX={tabsStartX} />
          <Text dimColor>{"─".repeat(Math.max(0, cardWidth - 6))}</Text>
          <SelectList items={activeTab.items} cursor={menuCursor} color={activeTab.color} />
        </Panel>
        <Footer text="←→ section · ↑↓ move · Enter select · click or scroll · q or ^C quit" />
      </Centered>
    );
  }

  if (screen === "new-project") {
    return (
      <Centered>
        <Breadcrumb />
        <Panel title="Adding Project">
          <Field label="Project Name" width={FIELD_WIDTH}>
            <TextField value={newProjectValue} onChange={setNewProjectValue} onSubmit={submitNewProject} />
          </Field>
          {newProjectError && (
            <Box marginTop={1}>
              <Text color="red">{newProjectError}</Text>
            </Box>
          )}
        </Panel>
        <Footer text="Enter submit · Esc back · ^A all · ^Y copy · ^V paste · ^X cut · ^C quit" />
      </Centered>
    );
  }

  if (screen === "project-menu" && activeProject) {
    registerRows(cardContentRow(false) + 2, projectMenuRows.length, (i) => {
      setProjectMenuCursor(i);
      openProjectMenuRow(projectMenuRows[i].value);
    });

    return (
      <Centered>
        <Breadcrumb />
        <Panel title={`📁 ${activeProject}`}>
          <Field label="Project">
            <SelectList items={projectMenuRows} cursor={list ? list.cursor : 0} />
          </Field>
        </Panel>
        <Footer text="↑↓ move · Enter open · click or scroll · Esc back · ^C quit" />
      </Centered>
    );
  }

  if (screen === "project-detail" && activeProject) {
    registerRows(cardContentRow(false) + 2, projectRows.length, (i) => {
      setProjectCursor(i);
      openProjectRow(projectRows[i].value);
    });

    return (
      <Centered>
        <Breadcrumb />
        <Panel title={`📁 ${activeProject}`}>
          <Field label={`Stored secrets (${projectKeys.length})`}>
            <SelectList items={projectRows} cursor={list ? list.cursor : 0} />
          </Field>
        </Panel>
        <Footer text="↑↓ move · Enter open · click or scroll · Esc back · ^C quit" />
      </Centered>
    );
  }

  if (screen === "key-detail" && activeProject && activeKey) {
    // cardContentRow(TRUE) - this panel carries a subtitle (the project name), which
    // pushes every row below it down one. Then: "Value" label, its box (border + 1 row +
    // border), blank, "Actions" label, its box border, then the action rows.
    registerRows(cardContentRow(true) + 1 + 1 + 2 + 1 + 2, currentKeyActions.length, (i) => {
      setKeyCursor(i);
      beginAction(currentKeyActions[i]);
    });

    return (
      <Centered>
        <Breadcrumb />
        <Panel title={`🔑 ${activeKey}`} subtitle={activeProject}>
          <Field label="Value">
            <Text dimColor>{SECRET_MASK}</Text>
          </Field>
          <Field label="Actions" marginTop={1}>
            <SelectList
              items={currentKeyActions.map((a) => ({ label: a.label, value: a.key }))}
              cursor={list ? list.cursor : 0}
            />
          </Field>
        </Panel>
        <Footer text="↑↓ move · Enter select · click or scroll · Esc back · ^C quit" />
      </Centered>
    );
  }

  if (screen === "steps" && current && currentStep) {
    const hint =
      currentStep.type === "select"
        ? "↑↓ move · Enter select · click or scroll · Esc back · ^C quit"
        : "Enter submit · Esc back · ^A all · ^Y copy · ^V paste · ^X cut · ^C quit · ^⌫ word";
    const heading = activeProject ? `${activeProject} — ${current.label}` : current.label;
    const tone = actionTone(current);
    const total = visibleSteps(current.steps, answers);
    const position = visiblePosition(current.steps, stepIndex, answers);
    const fieldWidth =
      currentStep.type === "select"
        ? Math.min(72, Math.max(FIELD_WIDTH, ...stepOptions.map((o) => o.label.length + 6), 20))
        : FIELD_WIDTH;

    if (currentStep.type === "select") {
      registerRows(cardContentRow(false) + (total > 1 ? 2 : 0) + 2, stepOptions.length, (i) => {
        setStepCursor(i);
        submitStep(stepOptions[i].value);
      });
    }

    return (
      <Centered>
        <Breadcrumb />
        <Panel title={heading} tone={tone}>
          <StepDots total={total} position={position} />
          <Field label={currentStep.prompt} width={fieldWidth}>
            {currentStep.type === "text" ? (
              <TextField
                value={textValue}
                mask={currentStep.mask ? "*" : undefined}
                onChange={setTextValue}
                onSubmit={submitStep}
              />
            ) : (
              <SelectList items={stepOptions} cursor={list ? list.cursor : 0} />
            )}
          </Field>
        </Panel>
        <Footer text={hint} />
      </Centered>
    );
  }

  if (screen === "result" || screen === "error") {
    return (
      <Centered>
        <Breadcrumb />
        <Panel title={screen === "error" ? "Error" : "Done"} tone={screen === "error" ? "error" : resultTone}>
          <ResultBody result={output} />
        </Panel>
        <Footer text="Enter or Esc back · ^C quit" />
      </Centered>
    );
  }

  return null;
}
