#!/bin/sh
# pytest, only where the project is set up for it and pytest is installed.
test -f pyproject.toml -o -f pytest.ini -o -f setup.cfg || exit 127
test -d tests -o -d test || exit 127
command -v pytest >/dev/null 2>&1 || exit 127
pytest -q
