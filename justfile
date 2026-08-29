# Development recipes. Run `just check` before committing.

# Run the unit test suite.
test:
    node --test test/*.test.mjs

# Syntax-check every module and entrypoint, then run tests.
check:
    #!/usr/bin/env sh
    set -eu
    for f in bin/*.mjs lib/*.mjs test/*.mjs; do
        node --check "$f"
    done
    node --test test/*.test.mjs
