#!/bin/sh
# Stand-in for the aoci CLI in tests: always reports a blocked index.
printf '%s' '{"ok":false,"governance_aligned":false,"structure_valid":true,"findings":[{"code":"code_stale"},{"code":"code_stale"},{"code":"code_missing"}]}'
exit 1
