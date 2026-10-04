#!/bin/sh
# The spec-home-isolation canary (the 2026-10-03 ruling): quarantine the real
# ~/.behavioral, run the FULL suite through the launch layer, assert green and
# that no new ~/.behavioral was created, then restore. Any machine (this Mac,
# CI, Blackwell, a Daytona-class sandbox) can prove a checkout clean with:
#
#   sh scripts/spec-home-canary.sh
#
# This script is the standard's enforcement until a named need automates it.
set -eu

cd "$(dirname "$0")/.."

REAL="${HOME}/.behavioral"
QUARANTINE="${REAL}.canary"

if [ -e "$QUARANTINE" ]; then
  echo "canary: $QUARANTINE already exists — a previous run did not restore; resolve it by hand" >&2
  exit 1
fi

quarantined=0
if [ -e "$REAL" ]; then
  mv "$REAL" "$QUARANTINE"
  quarantined=1
fi

restored=0
restore() {
  [ "$restored" -eq 0 ] || return 0
  restored=1
  if [ "$quarantined" -eq 1 ]; then
    if [ -e "$REAL" ]; then
      # A leak: keep the evidence set aside, then put the real home back.
      mv "$REAL" "${REAL}.leaked-by-canary"
      echo "canary: the suite created $REAL — evidence kept at ${REAL}.leaked-by-canary" >&2
    fi
    mv "$QUARANTINE" "$REAL"
  fi
}
trap restore EXIT INT TERM

status=0
bun run test || status=1

if [ -e "$REAL" ]; then
  echo "canary: FAIL — the suite touched the real home" >&2
  status=1
else
  echo "canary: OK — the full suite ran with the real home quarantined and no new home appeared"
fi

restore
exit "$status"