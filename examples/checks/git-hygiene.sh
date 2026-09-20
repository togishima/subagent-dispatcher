#!/bin/sh
# Conflict markers and broken whitespace in what the worker actually changed.
# Exit 127 means "this check does not apply here" — jev-dispatch treats that as
# no evidence rather than as a failure.
git rev-parse --git-dir >/dev/null 2>&1 || exit 127
git diff --check
