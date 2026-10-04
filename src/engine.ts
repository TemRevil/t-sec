// Engine: all crypto/file operations for the vault's age-encrypted secrets. Deliberately kept
// separate from the CLI/UI layer (cli.tsx, App.tsx) - this is the only part that touches real
// secret material or the filesystem outside the vault, so it stays small and is exercised by
// `selftest` before anything trusts it with real data.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";

export interface Device {
  label: string;
  added: string;
  publicKey: string;
}

export class VaultError extends Error {}

// Runtime state is separate from the installation and can be explicitly isolated.
const __here = path.dirname(fileURLToPath(import.meta.url));
export const VAULT_ROOT = path.resolve(process.env.TSEC_VAULT_DIR || path.join(os.homedir(), '.t-sec', 'vault'));
export const SECRETS_DIR = path.join(VAULT_ROOT, '_secrets');
export const RECIPIENTS_FILE = path.join(SECRETS_DIR, 'recipients.txt');
const IDENTITY_DIR = path.resolve(process.env.TSEC_IDENTITY_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 't-sec', 'identity'));
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.txt');

function findAgeBinary(name: "age" | "age-keygen"): string {
  const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
  if (!probe.error) return name; // resolvable via PATH

  if (process.platform === "win32") {
    const pkgRoot = path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "WinGet",
      "Packages",
    );
    if (fs.existsSync(pkgRoot)) {
      for (const entry of fs.readdirSync(pkgRoot)) {
        if (entry.startsWith("FiloSottile.age_")) {
          const candidate = path.join(pkgRoot, entry, "age", `${name}.exe`);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  throw new VaultError(
    `${name} not found. Install it: winget install --id FiloSottile.age -e`,
  );
}

function runAge(args: string[]): void {
  const bin = findAgeBinary("age");
  const result = spawnSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf-8").trim();
    throw new VaultError(`age failed: ${stderr || `exit ${result.status}`}`);
  }
}

function lockDownFile(filePath: string): void {
  if (process.platform === "win32") {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const r1 = spawnSync("icacls", [filePath, "/inheritance:r"], { stdio: "ignore" });
    const r2 = spawnSync("icacls", [filePath, "/grant:r", `${user}:(R,W)`], {
      stdio: "ignore",
    });
    if (r1.status !== 0 || r2.status !== 0) {
      throw new VaultError(
        `Could not lock down permissions on ${filePath} (icacls exit ${r1.status}/${r2.status}) - ` +
          `fix its ACL manually before trusting this identity file with real secrets.`,
      );
    }
  } else {
    fs.chmodSync(filePath, 0o600);
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t-sec-"));
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  try {
    return fn(dir);
  } finally {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0) {
        fs.writeFileSync(p, Buffer.alloc(stat.size)); // overwrite before delete
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Ensure this device has a local identity, generating one if needed. Returns its public key. */
export function ensureDeviceIdentity(): { publicKey: string; created: boolean } {
  if (fs.existsSync(IDENTITY_FILE)) {
    return { publicKey: readPublicKeyFromIdentity(), created: false };
  }
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  const keygen = findAgeBinary("age-keygen");
  const result = spawnSync(keygen, ["-o", IDENTITY_FILE], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    throw new VaultError(
      `age-keygen failed: ${result.stderr?.toString("utf-8").trim()}`,
    );
  }
  lockDownFile(IDENTITY_FILE);
  return { publicKey: readPublicKeyFromIdentity(), created: true };
}

/** This device's public key, or null if it has no identity yet (never generates one). */
export function currentDevicePublicKey(): string | null {
  if (!fs.existsSync(IDENTITY_FILE)) return null;
  return readPublicKeyFromIdentity();
}

function readPublicKeyFromIdentity(): string {
  const text = fs.readFileSync(IDENTITY_FILE, "utf-8");
  const m = text.match(/^# public key: (age1\S+)/m);
  if (!m) throw new VaultError(`Could not read a public key out of ${IDENTITY_FILE}`);
  return m[1];
}

export function fingerprint(publicKey: string): string {
  return publicKey.slice(-10);
}

export function readRecipients(): Device[] {
  if (!fs.existsSync(RECIPIENTS_FILE)) return [];
  const lines = fs.readFileSync(RECIPIENTS_FILE, "utf-8").split(/\r?\n/);
  const devices: Device[] = [];
  let pendingLabel: string | null = null;
  let pendingAdded: string | null = null;
  for (const line of lines) {
    const labelMatch = line.match(/^#\s*label:\s*(.+)$/);
    const addedMatch = line.match(/^#\s*added:\s*(.+)$/);
    const keyMatch = line.match(/^(age1\S+)$/);
    if (labelMatch) pendingLabel = labelMatch[1].trim();
    else if (addedMatch) pendingAdded = addedMatch[1].trim();
    else if (keyMatch) {
      devices.push({
        label: pendingLabel ?? "(unlabeled device)",
        added: pendingAdded ?? "unknown",
        publicKey: keyMatch[1],
      });
      pendingLabel = null;
      pendingAdded = null;
    }
  }
  return devices;
}

// Labels are free text (from `trust -l`, `rename`, or the menu's text step). Without this,
// an embedded newline plus a forged "age1..." line would be parsed back as a genuine extra
// trusted device on the next readRecipients() call - a rogue-recipient backdoor.
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[\r\n]+/g, " ").trim();
  return cleaned || "(unlabeled device)";
}

export function writeRecipients(devices: Device[]): void {
  const header = [
    "# Trusted device public keys for the vault's age-encrypted secrets.",
    "# Public keys are NOT sensitive - safe to be visible on this portable drive. The matching",
    "# PRIVATE key for each device lives only on that device (never on this drive). Managed by",
    "# _scripts/t-sec.mjs - use it (not a manual edit) to add/remove/rename a device,",
    "# so secrets get re-encrypted for the updated list automatically.",
    "",
  ];
  const body = devices.flatMap((d) => [
    `# label: ${sanitizeLabel(d.label)}`,
    `# added: ${d.added}`,
    d.publicKey,
    "",
  ]);
  // First `trust` against a brand-new vault runs before _secrets/ exists - without this the
  // whole command dies on a raw ENOENT instead of just creating the folder.
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(RECIPIENTS_FILE, [...header, ...body].join("\n"));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Trust this device: ensure it has an identity and is registered in recipients.txt.
 * Returns whether OTHER devices already existed (meaning a reencryptAll() is needed for this
 * device to actually gain access to existing secrets). */
export function trustThisDevice(label?: string): {
  publicKey: string;
  alreadyTrusted: boolean;
  othersExisted: boolean;
} {
  const { publicKey } = ensureDeviceIdentity();
  const devices = readRecipients();
  const others = devices.filter((d) => d.publicKey !== publicKey);
  const alreadyTrusted = devices.some((d) => d.publicKey === publicKey);
  if (!alreadyTrusted) {
    const defaultLabel = `${os.hostname()} (${os.userInfo().username})`;
    devices.push({ label: label || defaultLabel, added: todayIso(), publicKey });
    writeRecipients(devices);
  }
  return { publicKey, alreadyTrusted, othersExisted: others.length > 0 };
}

function findDevice(devices: Device[], labelOrFingerprint: string): Device | undefined {
  // Fingerprints/full public keys are cryptographically unique - trust those first. Only fall
  // back to label, and refuse rather than silently picking one if two devices share a label.
  const byKey = devices.filter(
    (d) => fingerprint(d.publicKey) === labelOrFingerprint || d.publicKey === labelOrFingerprint,
  );
  if (byKey.length === 1) return byKey[0];
  if (byKey.length > 1) {
    throw new VaultError(`Ambiguous match for "${labelOrFingerprint}" - recipients.txt may be corrupted`);
  }
  const byLabel = devices.filter((d) => d.label === labelOrFingerprint);
  if (byLabel.length > 1) {
    throw new VaultError(
      `Multiple devices are labeled "${labelOrFingerprint}" - use its fingerprint instead (see "List trusted devices").`,
    );
  }
  return byLabel[0];
}

export function removeDevice(labelOrFingerprint: string): Device {
  const devices = readRecipients();
  const target = findDevice(devices, labelOrFingerprint);
  if (!target) throw new VaultError(`No trusted device matches "${labelOrFingerprint}"`);
  writeRecipients(devices.filter((d) => d !== target));
  return target;
}

export function renameDevice(labelOrFingerprint: string, newLabel: string): Device {
  const devices = readRecipients();
  const target = findDevice(devices, labelOrFingerprint);
  if (!target) throw new VaultError(`No trusted device matches "${labelOrFingerprint}"`);
  target.label = newLabel;
  writeRecipients(devices);
  return target;
}

export function listProjects(): string[] {
  if (!fs.existsSync(SECRETS_DIR)) return [];
  return fs
    .readdirSync(SECRETS_DIR)
    .filter((f) => f.endsWith(".secrets.json.age"))
    .map((f) => f.slice(0, -".secrets.json.age".length))
    .sort();
}

// `project` comes from CLI args or the menu's free-text "new project name" step - reject
// anything that could escape SECRETS_DIR (path separators, "..", a leading dot) before it
// ever reaches path.join. Exported so the UI can validate a typed name up front instead of
// discovering it's invalid only once it tries to write - one validator, not two.
const PROJECT_NAME_RE = /^[A-Za-z0-9 _.-]+$/;

export function isValidProjectName(project: string): boolean {
  return PROJECT_NAME_RE.test(project) && !project.includes("..") && !project.startsWith(".");
}

function projectBlobPath(project: string): string {
  if (!isValidProjectName(project)) {
    throw new VaultError(`Invalid project name "${project}"`);
  }
  return path.join(SECRETS_DIR, `${project}.secrets.json.age`);
}

function requireIdentity(): void {
  if (!fs.existsSync(IDENTITY_FILE)) {
    throw new VaultError(
      `This device isn't trusted yet - run: t-sec trust`,
    );
  }
}

function decryptProject(project: string): Record<string, string> {
  requireIdentity();
  const blob = projectBlobPath(project);
  if (!fs.existsSync(blob)) return {};
  return withTempDir((dir) => {
    const plainPath = path.join(dir, "plain.json");
    runAge(["-d", "-i", IDENTITY_FILE, "-o", plainPath, blob]);
    const text = fs.readFileSync(plainPath, "utf-8");
    return JSON.parse(text);
  });
}

function encryptProject(project: string, data: Record<string, string>): void {
  if (!fs.existsSync(RECIPIENTS_FILE) || readRecipients().length === 0) {
    throw new VaultError("No trusted devices in recipients.txt - run: t-sec trust");
  }
  withTempDir((dir) => {
    const plainPath = path.join(dir, "plain.json");
    const outPath = path.join(dir, "out.age");
    fs.writeFileSync(plainPath, JSON.stringify(data, null, 2));
    runAge(["-R", RECIPIENTS_FILE, "-o", outPath, plainPath]);
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.copyFileSync(outPath, projectBlobPath(project));
  });
}

export function listKeys(project: string): string[] {
  return Object.keys(decryptProject(project)).sort();
}

export function getSecret(project: string, key: string): string {
  const data = decryptProject(project);
  if (!(key in data)) throw new VaultError(`Key "${key}" not found in "${project}"`);
  return data[key];
}

export function setSecret(project: string, key: string, value: string): void {
  const data = decryptProject(project);
  data[key] = value;
  encryptProject(project, data);
}

export function removeSecret(project: string, key: string): void {
  const data = decryptProject(project);
  if (!(key in data)) throw new VaultError(`Key "${key}" not found in "${project}"`);
  delete data[key];
  encryptProject(project, data);
}

/** Deletes a project and every secret it holds. There is no undo - the encrypted blob is gone,
 * not just unlinked from a list. */
export function removeProject(project: string): void {
  const blobPath = projectBlobPath(project);
  if (!fs.existsSync(blobPath)) throw new VaultError(`Project "${project}" not found`);
  fs.unlinkSync(blobPath);
}

/** Runs `command` with every one of the project's secrets injected into its environment
 * (by their stored key name), then exits with the child's own exit code. The values never
 * pass through this process's own stdout/stderr - only the child ever sees them, which is
 * the only way a caller (human or agent) can use a secret without reading or printing it. */
export function runWithSecrets(project: string, command: string[]): number {
  if (command.length === 0) throw new VaultError("No command given to run");
  const data = decryptProject(project);
  // No `shell: true` here: combined with a separate args array, Node itself warns this is a
  // shell-injection risk (args reach the shell concatenated, not escaped). That does mean a
  // pure .cmd/.bat shim (e.g. a bare `npm`) needs its extension spelled out on Windows -
  // real .exe tools (git, gh, node, python, curl) resolve fine as-is.
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...data },
  });
  if (result.error) throw new VaultError(`Could not run "${command[0]}": ${result.error.message}`);
  return result.status ?? 1;
}

export function reencryptAll(): { project: string; ok: boolean; error?: string }[] {
  requireIdentity();
  const results: { project: string; ok: boolean; error?: string }[] = [];
  for (const project of listProjects()) {
    try {
      const data = decryptProject(project);
      encryptProject(project, data);
      results.push({ project, ok: true });
    } catch (e) {
      results.push({ project, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

/** Round-trips dummy data through encrypt/decrypt with the current recipients + identity,
 * touching no real project file. Confirms the crypto pipeline itself is healthy. */
export function selftest(): void {
  requireIdentity();
  if (readRecipients().length === 0) {
    throw new VaultError("No trusted devices yet - run: t-sec trust");
  }
  const probe = { _selftest: crypto.randomBytes(8).toString("hex") };
  withTempDir((dir) => {
    const plainPath = path.join(dir, "plain.json");
    const encPath = path.join(dir, "out.age");
    const decPath = path.join(dir, "dec.json");
    fs.writeFileSync(plainPath, JSON.stringify(probe));
    runAge(["-R", RECIPIENTS_FILE, "-o", encPath, plainPath]);
    runAge(["-d", "-i", IDENTITY_FILE, "-o", decPath, encPath]);
    const roundtrip = JSON.parse(fs.readFileSync(decPath, "utf-8"));
    if (roundtrip._selftest !== probe._selftest) {
      throw new VaultError("Self-test round-trip mismatch - do not trust this build");
    }
  });
}

/** Add the installed CLI directory to the Windows user PATH. npm global installation also supplies a command shim. */
export function installOnPath(): {
  status: "installed" | "already-installed" | "unsupported";
  scriptsDir: string;
  removedStale: string[];
} {
  const scriptsDir = __here;
  if (process.platform !== "win32") {
    return { status: "unsupported", scriptsDir, removedStale: [] };
  }

  const getPath = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: "utf-8" },
  );
  if (getPath.status !== 0) {
    throw new VaultError(`Could not read User PATH: ${getPath.stderr}`);
  }
  const current = (getPath.stdout || "").trim();
  const entries = current.split(";").filter((e) => e.length > 0);

  const removedStale: string[] = [];
  const kept = entries.filter((e) => {
    const isOldScriptsDir = /\\_scripts\\?$/i.test(e) && e.toLowerCase() !== scriptsDir.toLowerCase();
    if (isOldScriptsDir && !fs.existsSync(e)) {
      removedStale.push(e);
      return false;
    }
    return true;
  });

  const alreadyPresent = kept.some((e) => e.toLowerCase() === scriptsDir.toLowerCase());
  if (alreadyPresent && removedStale.length === 0) {
    return { status: "already-installed", scriptsDir, removedStale };
  }

  const nextEntries = alreadyPresent ? kept : [...kept, scriptsDir];
  const nextPath = nextEntries.join(";");
  // Pass the value through an env var rather than interpolating it into the -Command string -
  // JSON.stringify's \\ escaping isn't valid PowerShell string syntax and previously corrupted
  // every backslash into a doubled one when written back to the real registry PATH.
  const setPath = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::SetEnvironmentVariable('Path', $env:TSEC_NEXT_PATH, 'User')",
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TSEC_NEXT_PATH: nextPath } },
  );
  if (setPath.status !== 0) {
    throw new VaultError(`Could not write User PATH: ${setPath.stderr?.toString("utf-8")}`);
  }
  return { status: "installed", scriptsDir, removedStale };
}

export function whoami(): { publicKey: string | null; device: Device | null } {
  const publicKey = currentDevicePublicKey();
  if (!publicKey) return { publicKey: null, device: null };
  const device = readRecipients().find((d) => d.publicKey === publicKey) ?? null;
  return { publicKey, device };
}

// --- repo-status: compare a project's local checkout against GitHub and its deployed VPS ---
// copy, using well-known (optional) keys already in the project's own secrets: LOCAL_REPO_PATH
// is the anchor - without it a project is skipped entirely. SSH_HOST/SSH_USER/SSH_PORT plus
// either SSH_KEY_LOCAL_PATH or SSH_PASSWORD reach the VPS; VPS_REPO_PATH is where the repo
// lives there, if the deployed copy is a git checkout at all.

export type LegStatus =
  | { kind: "unconfigured" }
  | { kind: "not-git-tracked" }
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      branch: string;
      commit: string;
      ahead: number;
      behind: number;
      files: string[];
      // Only computed when ahead>0 AND behind>0 - a pure fast-forward can never conflict, so
      // there's no point spinning up a throwaway worktree to check one.
      conflicts?: string[] | "unknown";
    };

export interface RepoStatus {
  project: string;
  local: { kind: "error"; message: string } | { kind: "ok"; branch: string; commit: string };
  github: LegStatus;
  vps: LegStatus;
}

function shortHash(h: string): string {
  return h.slice(0, 10);
}

function withConflicts(localPath: string, otherRef: string, leg: LegStatus): LegStatus {
  if (leg.kind !== "ok" || leg.ahead === 0 || leg.behind === 0) return leg;
  return { ...leg, conflicts: git.mergeConflicts(localPath, "HEAD", otherRef) };
}

export function repoStatus(project: string): RepoStatus {
  const data = decryptProject(project);
  const localPath = data.LOCAL_REPO_PATH;
  if (!localPath) {
    return {
      project,
      local: { kind: "error", message: "LOCAL_REPO_PATH not set" },
      github: { kind: "unconfigured" },
      vps: { kind: "unconfigured" },
    };
  }

  const local = git.localRepoInfo(localPath);
  if ("error" in local) {
    return {
      project,
      local: { kind: "error", message: local.error },
      github: { kind: "unconfigured" },
      vps: { kind: "unconfigured" },
    };
  }

  const result: RepoStatus = {
    project,
    local: { kind: "ok", branch: local.branch, commit: local.commit },
    github: { kind: "unconfigured" },
    vps: { kind: "unconfigured" },
  };

  if (local.remoteRef) {
    const div = git.divergence(localPath, local.remoteRef);
    const remoteCommit = git.resolveCommit(localPath, local.remoteRef);
    result.github =
      div === "unknown" || !remoteCommit
        ? { kind: "error", message: `could not compare against ${local.remoteRef}` }
        : withConflicts(localPath, local.remoteRef, { kind: "ok", branch: local.branch, commit: shortHash(remoteCommit), ...div });
  } else if (local.remoteUrl) {
    result.github = { kind: "error", message: `origin/${local.branch} not found - fetch may have failed` };
  }

  const vpsPath = data.VPS_REPO_PATH;
  if (data.SSH_HOST && data.SSH_USER && vpsPath) {
    const cfg: git.SshConfig = {
      host: data.SSH_HOST,
      user: data.SSH_USER,
      port: data.SSH_PORT ? Number(data.SSH_PORT) : undefined,
      keyPath: data.SSH_KEY_LOCAL_PATH,
      password: data.SSH_PASSWORD,
    };
    const vps = git.vpsRepoInfo(cfg, vpsPath);
    if (vps === "not-git-tracked") {
      result.vps = { kind: "not-git-tracked" };
    } else if ("error" in vps) {
      result.vps = { kind: "error", message: vps.error };
    } else {
      const div = git.divergence(localPath, vps.commit);
      result.vps =
        div === "unknown"
          ? { kind: "error", message: `VPS commit ${shortHash(vps.commit)} not found in local history - fetch/pull it first` }
          : withConflicts(localPath, vps.commit, { kind: "ok", branch: vps.branch, commit: shortHash(vps.commit), ...div });
    }
  }

  return result;
}

export function repoStatusAll(): RepoStatus[] {
  return listProjects()
    .map(repoStatus)
    .filter((r) => r.local.kind === "ok" || (r.local as { message: string }).message !== "LOCAL_REPO_PATH not set");
}

export { IDENTITY_FILE };
