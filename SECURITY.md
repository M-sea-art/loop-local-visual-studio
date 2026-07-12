# Security policy

Use [GitHub private vulnerability reporting](https://github.com/M-sea-art/loop-local-visual-studio/security/advisories/new) for security-sensitive problems. If that form is unavailable, contact the repository owner through their GitHub profile to request a private channel without including vulnerability details.

Never place API keys, tokens, passwords, private paths, design files, customer screenshots or production data in a public Issue. LLVS feedback is local by default. External publishing requires `-Publish`; public targets additionally require `-AllowPublic`, and the collector uploads only the allowlisted metadata schema.

Redaction is defense in depth, not permission to publish raw diagnostic content. Review `publicPreview` before authorizing external feedback.

The public repository does not authorize access to third-party Figma files, paid features, private repositories or consuming-project assets.
