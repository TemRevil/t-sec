# Security

## Report a vulnerability

Please use GitHub's private vulnerability reporting feature on this repository. Do not post real keys, decrypted values, identity files or exploitable details in a public issue. Maintainers may enable private reporting through the repository's Security settings.

## Threat model

age encrypts each project's JSON values to the registered recipient public keys. The private age identity stays on the device. Local file permissions restrict the identity on supported systems; a compromised or privileged account can still read it. Encryption does not protect a value after authorized decryption.

Runtime decryption uses a temporary directory, which is deleted in a finally block. Best-effort overwriting is not guaranteed secure erasure on SSDs, journaling filesystems, swap, snapshots or backups. Process crashes can leave temporary files. Keep the local device and its disk encryption protected.

`get`, clipboard actions, child environments, user-entered arguments and application logs can expose plaintext. Clipboard history and sync can retain copied values. Prefer `run` or stdin, and review the child program's logging. Do not use untrusted secret key names to override execution-sensitive environment variables.

Recipient registration is not an identity verification protocol. Review public keys out of band before re-encrypting. Device removal does not erase old ciphertext or revoke previously learned values. Rotate affected secrets after compromise. Changes to recipient lists and project files are not transactional, and concurrent updates can overwrite each other. Inspect every re-encryption result and keep private backups.

Optional VPS checks accept new SSH host keys on first connection; verify the host separately. Prefer key-based authentication. Legacy PuTTY password authentication passes the password to `plink` as an argument and can expose it to local process inspection. Local repository status fetches origin and conflict checking creates temporary detached Git worktrees; it does not deploy or push your project.

There is no password recovery service, encrypted memory guarantee, zero-knowledge server, automatic credential rotation or independent security audit. Secret scans are a defense in depth, not proof that arbitrary data is safe to publish.
