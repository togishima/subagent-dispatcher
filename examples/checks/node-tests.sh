#!/bin/sh
# The project's own test script, and only if it has one. A repo with no test
# script is not evidence of anything, so it exits 127 rather than passing.
test -f package.json || exit 127
node -e 'const s=require(process.cwd()+"/package.json").scripts||{};process.exit(s.test?0:127)' 2>/dev/null || exit 127
npm test --silent
