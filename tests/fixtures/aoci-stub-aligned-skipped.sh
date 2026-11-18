#!/bin/sh
# Stand-in for the aoci CLI in tests: aligned index whose only findings are skipped binaries.
printf '%s' '{"ok":true,"governance_aligned":true,"structure_valid":true,"findings":[{"code":"code_skipped"},{"code":"code_skipped"}]}'
exit 0
