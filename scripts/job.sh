#!/usr/bin/env bash
set -o pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
job_name="$1"
shift
mkdir -p "$root/logs"
job_log="$root/logs/$job_name-$(date +%Y%m%d-%H%M%S)-$$.log"
ln -sfn "$(basename "$job_log")" "$root/logs/$job_name.log"
set -x
"$@" 2>&1 | tee "$job_log"
job_status=${PIPESTATUS[0]}
set +x
printf '\njob=%s exit_status=%s\n' "$job_name" "$job_status" | tee -a "$job_log"
exit "$job_status"
