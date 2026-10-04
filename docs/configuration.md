# Configuration

`TSEC_VAULT_DIR` is the parent of `_secrets`; `TSEC_IDENTITY_DIR` contains this device's `identity.txt`. Set both before invoking t-sec when using a non-default vault or testing. Back up them separately; do not include either in this application's public repository. Install age and age-keygen on PATH.

## Optional repository status

Store these key names in the project's encrypted secrets, using your own values:

| Key | Meaning |
| --- | --- |
| `LOCAL_REPO_PATH` | Absolute path to a local Git checkout |
| `SSH_HOST` | Optional VPS hostname |
| `SSH_USER` | SSH account |
| `SSH_PORT` | Optional port, default 22 |
| `SSH_KEY_LOCAL_PATH` | Private key path on this device, preferred authentication |
| `SSH_PASSWORD` | Legacy PuTTY password fallback; avoid if possible |
| `VPS_REPO_PATH` | Remote checkout's path |

Run `t-sec repo-status example-app`. A Git fetch may occur. Diverged revisions are checked through disposable detached worktrees. SSH executes Git inspection commands; no deployment or push happens. Configure Git/SSH access outside t-sec and verify the server's host key. PuTTY may be needed for the legacy password fallback on Windows. See SECURITY.md before using it.

## Moving from the private vault build

The original installation inferred its vault from the launcher's parent and used a `PrimeVaultAge` identity folder. The public version does not infer that path or migrate data automatically. Explicitly set `TSEC_VAULT_DIR` to your existing vault parent and `TSEC_IDENTITY_DIR` to the existing identity directory only if you intentionally want to reuse them. Otherwise, use a fresh directory and `trust`. Do not commit migration values or personal paths.
