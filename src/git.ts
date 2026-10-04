// Git/SSH plumbing for the repo-status feature: compares a project's local checkout against
// its GitHub remote and its deployed VPS copy. Deliberately asymmetric - GitHub and the VPS
// each only need to report ONE commit hash; every ahead/behind count and every "which files
// differ" list is computed locally, against the local repo's own (already-fetched) object
// database. That works as long as the local clone has full history and neither remote force-
// pushed history the local repo never fetched - true for the normal case here.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  return { ok: !r.error && r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export interface LocalRepo {
  branch: string;
  commit: string;
  remoteUrl: string | null;
  remoteRef: string | null; // e.g. "origin/main" - only set if the fetch+lookup succeeded
}

export function localRepoInfo(repoPath: string): LocalRepo | { error: string } {
  if (!fs.existsSync(repoPath)) return { error: `path does not exist: ${repoPath}` };
  const head = run("git", ["rev-parse", "HEAD"], repoPath);
  if (!head.ok) return { error: `not a git repository: ${repoPath}` };
  const branch = run("git", ["branch", "--show-current"], repoPath).stdout || "(detached HEAD)";
  const remoteUrlRes = run("git", ["remote", "get-url", "origin"], repoPath);
  const remoteUrl = remoteUrlRes.ok ? remoteUrlRes.stdout : null;

  let remoteRef: string | null = null;
  if (remoteUrl) {
    run("git", ["fetch", "origin", "--quiet"], repoPath); // best-effort - offline shouldn't hard-fail the whole check
    const candidate = `origin/${branch}`;
    if (run("git", ["rev-parse", "--verify", "--quiet", candidate], repoPath).ok) remoteRef = candidate;
  }
  return { branch, commit: head.stdout, remoteUrl, remoteRef };
}

/** Resolves any ref (branch name, "origin/main", a raw hash) to its full commit hash. */
export function resolveCommit(repoPath: string, ref: string): string | null {
  const r = run("git", ["rev-parse", "--verify", "--quiet", ref], repoPath);
  return r.ok ? r.stdout : null;
}

export type Divergence = { ahead: number; behind: number; files: string[] } | "unknown";

/** How far `HEAD` in `repoPath` has diverged from `otherRef` (a ref name or a raw commit hash),
 * plus which files actually differ - the part that answers "will merging this conflict?".
 * "unknown" means otherRef isn't an object this repo's history actually has. */
export function divergence(repoPath: string, otherRef: string): Divergence {
  const counts = run("git", ["rev-list", "--left-right", "--count", `HEAD...${otherRef}`], repoPath);
  if (!counts.ok) return "unknown";
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  if (ahead === 0 && behind === 0) return { ahead: 0, behind: 0, files: [] };
  const diff = run("git", ["diff", "--name-only", "HEAD", otherRef], repoPath);
  return { ahead: ahead || 0, behind: behind || 0, files: diff.ok ? diff.stdout.split("\n").filter(Boolean) : [] };
}

/** Which files would actually conflict merging `theirs` into `ours` - not just which files
 * differ (two branches can touch the same file in non-overlapping places with no conflict at
 * all). Does the merge for real, in a throwaway worktree well away from the repo's actual
 * checkout, so it can never disturb whatever the user has open. "unknown" means either ref
 * isn't an object this repo's history actually has. */
export function mergeConflicts(repoPath: string, ours: string, theirs: string): string[] | "unknown" {
  const oursCommit = resolveCommit(repoPath, ours);
  const theirsCommit = resolveCommit(repoPath, theirs);
  if (!oursCommit || !theirsCommit) return "unknown";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t-sec-mergecheck-"));
  try {
    if (!run("git", ["worktree", "add", "--detach", "--quiet", tmpDir, oursCommit], repoPath).ok) {
      return "unknown";
    }
    run(
      "git",
      ["-c", "user.email=t-sec@local", "-c", "user.name=t-sec", "merge", "--no-commit", "--no-ff", theirsCommit],
      tmpDir,
    );
    const conflicted = run("git", ["diff", "--name-only", "--diff-filter=U"], tmpDir);
    return conflicted.ok ? conflicted.stdout.split("\n").filter(Boolean) : [];
  } finally {
    run("git", ["worktree", "remove", "--force", tmpDir], repoPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface SshConfig {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  password?: string;
}

// Plain `ssh` never accepts a password non-interactively - password auth needs `plink`. This
// machine has no standalone PuTTY/WinSCP install; the only real plink.exe found is the one
// Google Cloud SDK vendors for its own `gcloud compute ssh` on Windows. It's an unmodified
// PuTTY binary, so it works for an arbitrary host - it's just not guaranteed to be on every
// device this tool runs on, hence the search list instead of a bare "plink" assumption. A
// bundled pure-JS SSH client (ssh2) was tried and dropped: it can't bundle into this tool's
// single portable script (its lib/agent.js mixes require() and top-level await in a way esbuild
// can't turn into a form Node will load), and shipping a folder+node_modules instead breaks the
// "one file, works on any trusted device" model the rest of this tool depends on.
const PLINK_CANDIDATES = [
  "C:\\Program Files\\PuTTY\\plink.exe",
  "C:\\Program Files (x86)\\PuTTY\\plink.exe",
  "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\sdk\\plink.exe",
];

function findPlink(): string | null {
  if (run("plink", ["-V"]).ok) return "plink";
  for (const c of PLINK_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Runs one command on the remote host. Key auth uses plain `ssh`; password auth uses `plink`,
 * resolved via findPlink() since it isn't reliably on PATH. Password auth briefly puts the
 * password in the plink child process's own argv - prefer a key where you can. */
function sshExec(cfg: SshConfig, remoteCommand: string): { ok: boolean; stdout: string; stderr: string } {
  const port = String(cfg.port ?? 22);
  if (cfg.keyPath) {
    return run(
      "ssh",
      [
        "-i", cfg.keyPath, "-p", port,
        "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        `${cfg.user}@${cfg.host}`, remoteCommand,
      ],
    );
  }
  if (cfg.password) {
    const plink = findPlink();
    if (!plink) {
      return {
        ok: false,
        stdout: "",
        stderr: "plink not found (checked PATH, PuTTY, WinSCP, Google Cloud SDK) - install PuTTY or set SSH_KEY_LOCAL_PATH instead",
      };
    }
    const r = run(plink, ["-ssh", "-batch", "-P", port, "-pw", cfg.password, `${cfg.user}@${cfg.host}`, remoteCommand]);
    // Defense in depth: plink echoing its own invocation back in an error should never surface
    // the password to whatever prints this result.
    const redact = (s: string) => s.split(cfg.password!).join("[redacted]");
    return { ok: r.ok, stdout: redact(r.stdout), stderr: redact(r.stderr) };
  }
  return { ok: false, stdout: "", stderr: "no SSH auth method configured (need SSH_KEY_LOCAL_PATH or SSH_PASSWORD)" };
}

export type VpsRepo = { branch: string; commit: string } | "not-git-tracked" | { error: string };

export function vpsRepoInfo(cfg: SshConfig, vpsPath: string): VpsRepo {
  const head = sshExec(cfg, `git -C "${vpsPath}" rev-parse HEAD`);
  if (!head.ok) {
    if (/not a git repository/i.test(head.stderr)) return "not-git-tracked";
    return { error: head.stderr || "SSH command failed" };
  }
  const branchRes = sshExec(cfg, `git -C "${vpsPath}" branch --show-current`);
  return { branch: branchRes.ok && branchRes.stdout ? branchRes.stdout : "(detached HEAD)", commit: head.stdout };
}
