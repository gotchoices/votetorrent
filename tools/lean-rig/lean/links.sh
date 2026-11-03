#!/usr/bin/env bash
# links.sh - sourced by lean-part1.sh and run-lean.sh: each rig dir that Node resolves bare packages from gets a node_modules link to
# packages/vote-engine/node_modules (one patched copy of every package, as the scratch rig's hand-made symlinks did). Relative, gitignored.
_lr="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -d "$_lr/../../packages/vote-engine/node_modules" ] || { echo "REFUSE: packages/vote-engine/node_modules is missing (run yarn install)"; exit 9; }
for _d in lean part1 host-voter; do
  [ -L "$_lr/$_d/node_modules" ] || [ -e "$_lr/$_d/node_modules" ] || ln -s ../../../packages/vote-engine/node_modules "$_lr/$_d/node_modules"
done
unset _lr _d
