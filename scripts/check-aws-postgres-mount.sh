#!/usr/bin/env bash

# Read-only pre-start guard for the staging Supabase PostgreSQL container.
# Install beside the reviewed prepare-aws-postgres-volume.sh helper.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

script_dir=${BASH_SOURCE[0]%/*}
[[ $script_dir != "${BASH_SOURCE[0]}" ]] || script_dir=.
script_dir=$(cd -- "$script_dir" && pwd -P) || {
  printf 'Error: cannot resolve PostgreSQL mount guard directory\n' >&2
  exit 1
}
[[ -f $script_dir/prepare-aws-postgres-volume.sh && ! -L $script_dir/prepare-aws-postgres-volume.sh ]] || {
  printf 'Error: adjacent PostgreSQL volume helper is missing or a symlink\n' >&2
  exit 1
}
# The preparation helper runs main only when executed directly. Reuse its
# reviewed read-only Nitro, filesystem, UUID, and mount identity probes.
# shellcheck source=prepare-aws-postgres-volume.sh
source "$script_dir/prepare-aws-postgres-volume.sh"

read_mount_options() {
  findmnt --noheadings --raw --output OPTIONS --mountpoint "$MOUNTPOINT"
}

path_device_number() { stat -c '%d' -- "$1"; }

ensure_real_directory() {
  local path=$1 parent=$1
  [[ -d $path ]] || die "Required PostgreSQL path is not a directory: $path"
  while [[ $parent != / ]]; do
    [[ ! -L $parent ]] || die "PostgreSQL path contains a symlink: $parent"
    parent=${parent%/*}
    [[ -n $parent ]] || parent=/
  done
}

ensure_data_paths() {
  local path mount_device path_device submounts
  ensure_real_directory "$MOUNTPOINT"
  submounts=$(read_submounts) || die 'Cannot inspect PostgreSQL submounts'
  [[ $submounts == "$MOUNTPOINT" ]] || die 'Unexpected nested mount under PostgreSQL data volume'
  mount_device=$(path_device_number "$MOUNTPOINT") || die 'Cannot identify PostgreSQL mount filesystem'
  [[ -n $mount_device ]] || die 'PostgreSQL mount has no filesystem identity'
  for path in "$MOUNTPOINT/data" "$MOUNTPOINT/postgresql-custom"; do
    ensure_real_directory "$path"
    path_device=$(path_device_number "$path") || die "Cannot identify filesystem for $path"
    [[ $path_device == "$mount_device" ]] || die "PostgreSQL path is off the data filesystem: $path"
  done
}

ensure_writable_mount() {
  local options
  options=$(read_mount_options) || die 'Cannot read PostgreSQL mount options'
  [[ -n $options && $options != *$'\n'* ]] || die 'Invalid PostgreSQL mount options'
  case ",$options," in
    *,rw,*) ;;
    *) die 'PostgreSQL data volume is not mounted read-write' ;;
  esac
  case ",$options," in
    *,ro,*) die 'PostgreSQL data volume reports read-only mount options' ;;
  esac
}

main() {
  local volume_id expected_uuid device state
  (( $# == 4 )) && [[ $1 == --volume-id && $3 == --expected-uuid ]] ||
    die 'Usage: check-aws-postgres-mount.sh --volume-id vol-<17 hex> --expected-uuid <recorded XFS UUID>'
  volume_id=$2
  expected_uuid=$4
  [[ $volume_id =~ ^vol-[0-9a-f]{17}$ ]] || die 'Use an exact 17-digit hexadecimal EBS volume ID'
  [[ $expected_uuid =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
    die 'Expected UUID must be a recorded XFS filesystem UUID'
  require_root

  device=$(resolve_device "$volume_id") || die 'Cannot resolve the exact EBS volume'
  ensure_unpartitioned "$device"
  state=$(filesystem_state "$device") || die 'Cannot inspect the exact EBS filesystem'
  [[ $state == "xfs:$expected_uuid" ]] || die 'PostgreSQL XFS UUID differs from the recorded UUID'
  ensure_unique_uuid "$device" "$expected_uuid"
  [[ $(ensure_mount_state "$device" "$expected_uuid") == mounted ]] ||
    die "PostgreSQL data volume is not mounted at $MOUNTPOINT"
  ensure_writable_mount
  ensure_data_paths
  printf 'volume_id=%s device=%s filesystem=xfs uuid=%s mount=%s status=ready\n' \
    "$volume_id" "$device" "$expected_uuid" "$MOUNTPOINT"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
