# Contributing

Use Node.js 22+ and install age. Run `npm ci` and `npm run check` before opening a pull request. Tests must use disposable paths and fake credentials, never a personal or production vault.

Keep encryption/file operations separate from the CLI and terminal UI. Add regression coverage for changes to storage, trust, command execution or parsing. Do not weaken strict TypeScript settings to make a check pass.

Never include vault files, device identities, `.env` files, real hosts, passwords or customer data in commits, screenshots or issues. Use private vulnerability reporting for security issues. Contributions are made under the repository's MIT license.
