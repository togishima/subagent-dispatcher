# Example verification checks

Four checks that can be pointed at from `~/.jev-dispatch/config.yaml`. They are
here because the shape matters more than the commands: each one **exits 127 when
it does not apply**, which `src/verify/index.mjs` reads as "nothing could judge
this" rather than as a failure.

Without that, a repository with no test script fails every delegation. With it,
the verdict is `UNCERTAIN` — an honest "nobody checked" — and the policy keeps
routing conservatively instead of acting on a verdict nobody earned. The other
half of the same rule: a repository with no tests is never reported as `PASS`.

```yaml
verification:
  checks:
    - name: git hygiene
      command: /Users/you/.jev-dispatch/checks/git-hygiene.sh
      timeoutMs: 30000
    - name: node tests
      when:
        changedFilesMatch: "[.](mjs|cjs|js|jsx|ts|tsx)$"
      command: /Users/you/.jev-dispatch/checks/node-tests.sh
      timeoutMs: 600000
```

Write `changedFilesMatch` with character classes (`[.]py$`) rather than escapes:
the config reader is a small YAML subset, and a backslash is one more thing that
has to survive it.

`rust-tests.sh` runs `cargo clippy -- -D warnings` before the tests. On a
repository that already carries clippy warnings this fails on work the delegated
worker never touched — clear that backlog, or drop `-D warnings`.
