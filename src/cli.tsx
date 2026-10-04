#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import * as readline from "node:readline";
import App from "./App.js";
import * as engine from "./engine.js";
import { enterFullscreenMouse, exitFullscreenMouse } from "./mouse.js";

const program = new Command();

program
  .name("t-sec")
  .description(
    "t-sec age-encrypted secrets. Run with no command for an interactive menu; " +
      "use a subcommand for scripts/agents (prints only what's asked for, nothing extra).",
  )
  .version("1.0.0");

program
  .command("install")
  .description("Add t-sec to this device's PATH, so it runs from any shell")
  .action(() => {
    const { status, scriptsDir, removedStale } = engine.installOnPath();
    for (const s of removedStale) {
      console.log(`removed stale PATH entry (no longer exists): ${s}`);
    }
    if (status === "unsupported") {
      console.log(`not supported on this OS - add "${scriptsDir}" to PATH manually`);
    } else if (status === "already-installed") {
      console.log(`already on PATH: ${scriptsDir}`);
    } else {
      console.log(`added to PATH: ${scriptsDir}`);
      console.log("open a new terminal for it to take effect");
    }
  });

program
  .command("trust")
  .description("Trust this device (generate its identity if needed, register its public key)")
  .option("-l, --label <label>", "label for this device (default: hostname + username)")
  .action((opts) => {
    const { publicKey, alreadyTrusted, othersExisted } = engine.trustThisDevice(opts.label);
    console.log(`fingerprint: ${engine.fingerprint(publicKey)}`);
    console.log(alreadyTrusted ? "already trusted" : "trusted just now");
    if (!alreadyTrusted && othersExisted) {
      console.error(
        "warning: other devices already exist - this device cannot decrypt existing " +
          "secrets until an already-trusted device runs `reencrypt`",
      );
    }
  });

program
  .command("whoami")
  .description("Show which device this is and whether it's trusted")
  .action(() => {
    const { publicKey, device } = engine.whoami();
    if (!publicKey) {
      console.log("no identity yet - not trusted (run: trust)");
      return;
    }
    console.log(`fingerprint: ${engine.fingerprint(publicKey)}`);
    console.log(`label: ${device ? device.label : "(not in recipients.txt)"}`);
    console.log(`trusted: ${device ? "yes" : "no"}`);
  });

program
  .command("devices")
  .description("List trusted devices")
  .action(() => {
    const pk = engine.currentDevicePublicKey();
    for (const d of engine.readRecipients()) {
      const mark = d.publicKey === pk ? "  <- this device" : "";
      console.log(`${engine.fingerprint(d.publicKey)}  ${d.label}  (added ${d.added})${mark}`);
    }
  });

program
  .command("rename <target> <newLabel>")
  .description("Rename a trusted device (target = its current label or fingerprint)")
  .action((target, newLabel) => {
    const d = engine.renameDevice(target, newLabel);
    console.log(`renamed to "${d.label}"`);
  });

program
  .command("remove <target>")
  .description("Remove a trusted device and re-encrypt secrets for the remaining devices")
  .option("-y, --yes", "skip confirmation")
  .action(async (target, opts) => {
    if (!opts.yes) {
      const ok = await confirm(`Remove device "${target}"? [y/N] `);
      if (!ok) {
        console.log("cancelled");
        return;
      }
    }
    const removed = engine.removeDevice(target);
    console.log(`removed "${removed.label}"`);
    for (const r of engine.reencryptAll()) {
      console.log(r.ok ? `  ok  ${r.project}` : `  FAIL  ${r.project}: ${r.error}`);
    }
  });

program
  .command("list [project]")
  .description("List projects with stored secrets, or key names for one project (no values)")
  .action((project) => {
    if (!project) {
      for (const p of engine.listProjects()) console.log(p);
      return;
    }
    for (const k of engine.listKeys(project)) console.log(k);
  });

program
  .command("get <project> <key>")
  .description("Print one secret value, and nothing else (safe to capture in a script)")
  .action((project, key) => {
    process.stdout.write(engine.getSecret(project, key));
  });

program
  .command("set <project> <key> [value]")
  .description("Add or update one secret. Omit value to read it from stdin (keeps it off argv).")
  .action(async (project, key, value) => {
    const v = value ?? (await readStdin());
    engine.setSecret(project, key, v);
    console.log(`saved ${key} in "${project}"`);
  });

program
  .command("remove-key <project> <key>")
  .description("Remove one secret key from a project")
  .action((project, key) => {
    engine.removeSecret(project, key);
    console.log(`removed ${key} from "${project}"`);
  });

program
  .command("remove-project <project>")
  .description("Delete a project and every secret it holds - no undo")
  .option("-y, --yes", "skip confirmation")
  .action(async (project, opts) => {
    if (!opts.yes) {
      const ok = await confirm(`Delete "${project}" and ALL its secrets? [y/N] `);
      if (!ok) {
        console.log("cancelled");
        return;
      }
    }
    engine.removeProject(project);
    console.log(`removed project "${project}"`);
  });

program
  .command("run <project> [command...]")
  .description(
    "Run a command with the project's secrets injected into its environment (by key name) - " +
      "the values are never printed, only the child process sees them. " +
      "Usage: t-sec run <project> -- <command> [args...]",
  )
  .action((project, command) => {
    if (!command || command.length === 0) {
      console.error("usage: t-sec run <project> -- <command> [args...]");
      process.exitCode = 1;
      return;
    }
    process.exitCode = engine.runWithSecrets(project, command);
  });

function conflictSuffix(leg: engine.LegStatus): string {
  if (leg.kind !== "ok" || leg.conflicts === undefined) return "";
  if (leg.conflicts === "unknown") return " (conflicts: unknown)";
  return leg.conflicts.length === 0 ? " (clean merge)" : ` (${leg.conflicts.length} would conflict)`;
}

function legCell(leg: engine.LegStatus): string {
  if (leg.kind === "unconfigured") return "-";
  if (leg.kind === "not-git-tracked") return "not git-tracked";
  if (leg.kind === "error") return `error: ${leg.message}`;
  if (leg.ahead === 0 && leg.behind === 0) return "in sync";
  return `+${leg.ahead}/-${leg.behind}${conflictSuffix(leg)}`;
}

program
  .command("repo-status [project]")
  .description(
    "Compare a project's local checkout against its GitHub remote and its deployed VPS copy " +
      "(local/GitHub/VPS - only the surfaces a project has configured are shown). Diverged legs " +
      "(both ahead and behind) get a real merge-conflict check, not just a list of differing files. " +
      "No project given: overview table across every project with LOCAL_REPO_PATH set.",
  )
  .action((project?: string) => {
    if (project) {
      const r = engine.repoStatus(project);
      console.log(`project  ${r.project}`);
      if (r.local.kind === "error") {
        console.log(`local    error: ${r.local.message}`);
        return;
      }
      console.log(`local    ${r.local.branch}@${r.local.commit.slice(0, 10)}`);
      console.log(`github   ${legCell(r.github)}`);
      if (r.github.kind === "ok" && r.github.conflicts && r.github.conflicts !== "unknown") {
        for (const f of r.github.conflicts) console.log(`           CONFLICT: ${f}`);
      }
      if (r.github.kind === "ok" && r.github.files.length > 0) {
        for (const f of r.github.files) console.log(`           ${f}`);
      }
      console.log(`vps      ${legCell(r.vps)}`);
      if (r.vps.kind === "ok" && r.vps.conflicts && r.vps.conflicts !== "unknown") {
        for (const f of r.vps.conflicts) console.log(`           CONFLICT: ${f}`);
      }
      if (r.vps.kind === "ok" && r.vps.files.length > 0) {
        for (const f of r.vps.files) console.log(`           ${f}`);
      }
      return;
    }
    const rows = engine.repoStatusAll();
    if (rows.length === 0) {
      console.log("No project has LOCAL_REPO_PATH set - nothing to compare.");
      return;
    }
    const widths = { project: 8, local: 5, github: 6, vps: 3 };
    for (const r of rows) {
      widths.project = Math.max(widths.project, r.project.length);
      const localCell = r.local.kind === "ok" ? `${r.local.branch}@${r.local.commit.slice(0, 10)}` : "error";
      widths.local = Math.max(widths.local, localCell.length);
      widths.github = Math.max(widths.github, legCell(r.github).length);
      widths.vps = Math.max(widths.vps, legCell(r.vps).length);
    }
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    console.log(`${pad("PROJECT", widths.project)}  ${pad("LOCAL", widths.local)}  ${pad("GITHUB", widths.github)}  VPS`);
    for (const r of rows) {
      const localCell = r.local.kind === "ok" ? `${r.local.branch}@${r.local.commit.slice(0, 10)}` : `error: ${r.local.message}`;
      console.log(`${pad(r.project, widths.project)}  ${pad(localCell, widths.local)}  ${pad(legCell(r.github), widths.github)}  ${legCell(r.vps)}`);
    }
  });

program
  .command("reencrypt")
  .description("Re-encrypt all projects' secrets for the current trusted-device list")
  .action(() => {
    for (const r of engine.reencryptAll()) {
      console.log(r.ok ? `ok    ${r.project}` : `FAIL  ${r.project}: ${r.error}`);
    }
  });

program
  .command("selftest")
  .description("Round-trip dummy data through encrypt/decrypt to verify the pipeline is healthy")
  .action(() => {
    engine.selftest();
    console.log("ok - encrypt/decrypt round-trip is healthy");
  });

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// Reads all of stdin (not just the first line) so a piped multi-line secret - an SSH key,
// a PEM block - isn't silently truncated to its first line.
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
  });
}

if (process.argv.length <= 2) {
  // Interactive mode only: switch to the alternate screen and turn on mouse reporting, and
  // make sure BOTH get switched back off however we leave - a missed restore leaves the
  // user's shell echoing mouse escape codes and unable to scroll.
  enterFullscreenMouse();
  const restore = () => exitFullscreenMouse();
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(0);
  });
  // exitOnCtrlC:false because inside a text field Ctrl+C means copy. App handles the quit
  // case itself everywhere a field isn't focused.
  const app = render(React.createElement(App), { exitOnCtrlC: false });
  app.waitUntilExit().then(restore, (e) => {
    restore();
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  });
} else {
  program.parseAsync(process.argv).catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
