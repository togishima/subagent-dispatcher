#!/bin/sh
# Tests and lint. Lint runs first: it compiles the same crates and fails sooner
# than a full test run, so a lint error costs less than a test cycle to find.
#
# Exit 127 means "this check does not apply here" — no Cargo.toml, or no
# toolchain — which jev-dispatch reads as no evidence rather than as a failure.
test -f Cargo.toml || exit 127
command -v cargo >/dev/null 2>&1 || exit 127

# clippy is a separate component and may not be installed; its absence must not
# turn into a verdict, so the lint step is simply skipped when it is missing.
if cargo clippy --version >/dev/null 2>&1; then
  cargo clippy --quiet --all-targets -- -D warnings || exit $?
fi

cargo test --quiet
