#!/bin/sh
# Stand-in for the aoci CLI in tests: a blocked index whose only findings the model cannot act on
# are skipped binaries, plus one stale source file.
printf '%s' '{"ok":false,"governance_aligned":false,"structure_valid":true,"findings":[{"code":"code_skipped"},{"code":"code_skipped"},{"code":"code_stale"}]}'
exit 1
