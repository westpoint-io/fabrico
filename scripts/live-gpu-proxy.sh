#!/usr/bin/env bash
# live-gpu-proxy.sh <on_ms> <off_ms> <duty_log> -- <command...>
#
# A LOCAL proxy for CI's live e2e renderer. CI never runs this script.
#
# WHY IT EXISTS (plan 84-13, D-12). The midday 2026-10-13 CI run drew the live suite's
# pages at about 5 to 5.8 frames a second: the GitHub runner renders WebGL through software
# GL (SwiftShader) on two shared cores. The local throttles phase 84 used before (two pinned
# cores, CPU quotas) slow the page's JavaScript and the host as much as the frames, so they
# never reproduced it: pinned to two cores a fast desktop still draws 25 to 28 frames a second.
# This script slows the FRAMES ALONE by duty-cycling only the Chromium GPU process (SIGSTOP
# for <off_ms>, SIGCONT for <on_ms>) while the page's JavaScript and the host run at speed.
# The on/off pair is calibrated in 84-GATES.md ("THE GPU PROXY") until a live frame sampler
# measures 4.5 to 5.0 frames a second, the floor D-12 restates every frame-bound cap against.
#
# WHAT IT TOUCHES. Only processes whose command line carries `type=gpu-process` AND whose
# /proc/<pid>/cgroup equals this script's own, so the GPU process of another application
# (a browser on the desktop, another concurrent run) is never stopped. Run it inside its
# own transient unit (`systemd-run --user ...`) so that cgroup holds nothing else. An EXIT,
# INT and TERM trap sends SIGCONT to every pid it ever stopped, so nothing is left frozen.
#
# IT CANNOT PASS WITHOUT SLOWING ANYTHING. It exits with the wrapped command's code, except
# exit 3 naming `NO GPU PROCESS` (in the duty log and on stderr) when the command ended and
# no GPU process was ever stopped: a "proxy run" that slowed nothing is a named failure.
#
# THE DUTY LOG. `GPU_PROXY start on=<ms> off=<ms>`, then every 10 s `GPU_PROXY stopped=<n>
# stops=<n>` (distinct pids stopped in that interval, and the stop signals sent), then
# `GPU_PROXY end rc=<n> ever_stopped=<n> pids=<list>`.
set -u

usage() {
  echo "usage: live-gpu-proxy.sh <on_ms> <off_ms> <duty_log> -- <command...>" >&2
  exit 2
}

[ "$#" -ge 5 ] || usage
ON_MS="$1"
OFF_MS="$2"
DUTY_LOG="$3"
shift 3
[ "$1" = "--" ] || usage
shift
case "$ON_MS" in '' | *[!0-9]*) usage ;; esac
case "$OFF_MS" in '' | *[!0-9]*) usage ;; esac
[ "$ON_MS" -gt 0 ] && [ "$OFF_MS" -gt 0 ] || usage

ON_S=$(awk -v m="$ON_MS" 'BEGIN { printf "%.3f", m / 1000 }')
OFF_S=$(awk -v m="$OFF_MS" 'BEGIN { printf "%.3f", m / 1000 }')
MY_CGROUP=$(cat "/proc/$$/cgroup")

declare -A EVER_STOPPED=()
CHILD=""

log() { echo "$*" >> "$DUTY_LOG"; }

# The GPU processes in this script's own cgroup, one pid per line.
own_gpu_pids() {
  local p
  for p in $(pgrep -f 'type=gpu-process'); do
    [ "$p" = "$$" ] && continue
    [ -r "/proc/$p/cgroup" ] || continue
    [ "$(cat "/proc/$p/cgroup" 2>/dev/null)" = "$MY_CGROUP" ] || continue
    echo "$p"
  done
}

# SIGCONT to every pid this script ever stopped that still lives in its cgroup.
restore_all() {
  local p
  for p in "${!EVER_STOPPED[@]}"; do
    if [ "$(cat "/proc/$p/cgroup" 2>/dev/null)" = "$MY_CGROUP" ]; then
      kill -CONT "$p" 2>/dev/null
    fi
  done
}

on_signal() {
  restore_all
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  log "GPU_PROXY interrupted by $1"
  exit 130
}

trap restore_all EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

log "GPU_PROXY start on=${ON_MS} off=${OFF_MS}"

"$@" &
CHILD=$!

declare -A INTERVAL_PIDS=()
INTERVAL_STOPS=0
NEXT_REPORT=$((SECONDS + 10))

while kill -0 "$CHILD" 2>/dev/null; do
  PIDS=$(own_gpu_pids)
  if [ -n "$PIDS" ]; then
    for p in $PIDS; do
      if kill -STOP "$p" 2>/dev/null; then
        EVER_STOPPED[$p]=1
        INTERVAL_PIDS[$p]=1
        INTERVAL_STOPS=$((INTERVAL_STOPS + 1))
      fi
    done
    sleep "$OFF_S"
    for p in $PIDS; do kill -CONT "$p" 2>/dev/null; done
    sleep "$ON_S"
  else
    sleep 0.1
  fi
  if [ "$SECONDS" -ge "$NEXT_REPORT" ]; then
    log "GPU_PROXY stopped=${#INTERVAL_PIDS[@]} stops=${INTERVAL_STOPS}"
    INTERVAL_PIDS=()
    INTERVAL_STOPS=0
    NEXT_REPORT=$((SECONDS + 10))
  fi
done

wait "$CHILD"
RC=$?
restore_all
log "GPU_PROXY stopped=${#INTERVAL_PIDS[@]} stops=${INTERVAL_STOPS}"
log "GPU_PROXY end rc=${RC} ever_stopped=${#EVER_STOPPED[@]} pids=${!EVER_STOPPED[*]}"

if [ "${#EVER_STOPPED[@]}" -eq 0 ]; then
  log "NO GPU PROCESS: the wrapped command ended (rc=${RC}) and no GPU process in this cgroup was ever stopped; nothing was slowed"
  echo "live-gpu-proxy: NO GPU PROCESS: the wrapped command ended (rc=${RC}) and no GPU process was ever stopped; nothing was slowed" >&2
  exit 3
fi
exit "$RC"
