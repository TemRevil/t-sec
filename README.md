# t-sec

An [age](https://github.com/FiloSottile/age)-encrypted secrets manager for developers. Use its terminal UI to manage project secrets, or its CLI to inject them into another process without printing them first.

- Separate encrypted secret files for each project.
- A private age identity per device; shared recipient public keys.
- Add, rename and remove trusted devices, with explicit re-encryption.
- Interactive terminal UI with keyboard navigation, mouse support and clipboard helpers.
- Optional comparison of local Git, origin and VPS revisions.

This repository contains application code only. It contains no production keys, encrypted vaults, trusted-device lists or personal configuration. It is not an independently audited security product.

## Requirements

Node.js 22 or newer, npm, and `age` / `age-keygen` on PATH. Install age following its [official installation instructions](https://github.com/FiloSottile/age#installation). Git is needed only for repository status; SSH for optional VPS status. Terminal clipboard support depends on the operating system.

## Install from source

```sh
git clone https://github.com/TemRevil/t-sec.git
cd t-sec
npm ci
npm run build
npm install -g . --ignore-scripts
t-sec --help
```

Build before the global installation. This project has not been published to the npm registry; the scoped package name describes the local package. `node dist/t-sec.mjs` also works without global installation. On Windows, `dist/t-sec.cmd` is an alternative launcher. The optional `t-sec install` command adds that launcher's directory to your Windows user PATH; npm global installation already creates a command shim.

## Start your own vault

By default, encrypted projects live under `~/.t-sec/vault/_secrets`. The private identity lives under `%LOCALAPPDATA%/t-sec/identity` on Windows or `~/t-sec/identity` elsewhere. Override these with `TSEC_VAULT_DIR` and `TSEC_IDENTITY_DIR`; relative overrides resolve from the current working directory.

For example, in PowerShell:

```powershell
$env:TSEC_VAULT_DIR = Join-Path $HOME 'my-team-vault'
$env:TSEC_IDENTITY_DIR = Join-Path $env:LOCALAPPDATA 'my-tsec-identity'
t-sec trust --label 'my-laptop'
t-sec selftest
```

Or on macOS/Linux:

```sh
export TSEC_VAULT_DIR="$HOME/my-team-vault"
export TSEC_IDENTITY_DIR="$HOME/.local/share/t-sec/identity"
t-sec trust --label my-laptop
t-sec selftest
```

Keep the identity directory separate from any synced or shared vault. Never commit `identity.txt`, real credentials or your configured vault to this public repository.

## Everyday commands

Run `t-sec` in an interactive terminal to open the menu. Use `t-sec --help` or `t-sec <command> --help` for options.

```sh
t-sec list
t-sec list example-app
t-sec whoami
t-sec devices
t-sec run example-app -- node server.mjs
```

To save a value, omit the optional positional value and send it on stdin. This keeps it out of the t-sec command's arguments, but your shell may still record how you obtained it:

```sh
printf '%s' 'example-only-value' | t-sec set example-app DEMO_TOKEN
```

`get` deliberately prints plaintext; use it only when that is what you intend. `run` passes secrets as environment variables to the child. The child can still log them, and suitably privileged local processes can inspect its environment. On Windows, prefer executable commands such as `node`; shell built-ins and `.cmd`/`.bat` wrappers are not supported by the shell-free runner.

| Command | Purpose |
| --- | --- |
| `trust --label <label>` | Generate this device's identity and register its public key |
| `whoami`, `devices` | Inspect device trust without printing private identities |
| `rename <target> <label>` | Rename a device by label or fingerprint |
| `remove <target>` | Remove a recipient and re-encrypt remaining projects |
| `list [project]` | List project or key names |
| `set <project> <key> [value]` | Save a value; stdin is preferred |
| `get <project> <key>` | Print exactly one plaintext value |
| `remove-key <project> <key>` | Remove one stored key |
| `remove-project <project>` | Delete a project's encrypted file |
| `run <project> -- <command> [args...]` | Run a child with the project's secret environment |
| `reencrypt` | Re-encrypt all projects for current recipients |
| `selftest` | Round-trip dummy data with the current identity and recipients |
| `repo-status [project]` | Compare configured repository revisions |

## Share with another device

1. Share the private vault's encrypted files and `recipients.txt` through a channel you control. Never share private identities.
2. The new device sets its vault path and runs `t-sec trust --label <label>` to register its public recipient key.
3. Verify the new public key through a trusted channel. An existing trusted device receives the updated recipient list and runs `t-sec reencrypt`.
4. Send the re-encrypted files back to the new device, then run `t-sec selftest` there.

Adding a recipient alone cannot decrypt old files. Removing a recipient and re-encrypting cannot revoke secrets it already learned or retained ciphertext copies; rotate compromised credentials separately. Back up your private identity securely: encrypted files cannot be recovered without an authorized identity.

Do not edit the same project concurrently from multiple devices. Storage currently has no distributed locking or automatic conflict resolution. See [SECURITY.md](SECURITY.md) for the threat model and limitations, and [configuration](docs/configuration.md) for optional repository status.

## Development

```sh
npm ci
npm run check
```

Checks include strict TypeScript, building, real age round trips using disposable test-only identities, command injection/exit behavior, and a source/package secret-pattern scan. CI runs on Windows, macOS and Linux. No tests use your existing vault or identity. The build bundles the CLI and runtime dependencies, including Ink's WASM layout engine; its development-only devtools import is stubbed.

- `src/engine.ts`: encrypted storage, identities and command execution.
- `src/cli.tsx`: scriptable commands.
- `src/App.tsx`, `TextField.tsx`, `mouse.ts`: terminal UI.
- `src/git.ts`: optional local/remote/VPS comparisons.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
