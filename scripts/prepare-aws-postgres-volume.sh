#!/usr/bin/env bash

# Prepare only the separately attached staging PostgreSQL EBS volume. No
# database process, container, or key material is created here.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

MOUNTPOINT=/srv/wallie/postgres
FSTAB=/etc/fstab

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  die 'Usage: prepare-aws-postgres-volume.sh inspect --volume-id vol-<17 hex> | mount --volume-id vol-<17 hex> --expected-uuid <recorded XFS UUID> | initialize --volume-id vol-<17 hex> --confirm-format vol-<same 17 hex>'
}

require_root() { (( EUID == 0 )) || die 'Run as root to inspect the complete block-device signatures and change mounts'; }
read_inventory() { lsblk --nodeps --noheadings --output PATH,TYPE,SERIAL; }
read_device_tree() { lsblk --noheadings --raw --output PATH,TYPE "$1"; }
read_device_mounts() { lsblk --noheadings --raw --output MOUNTPOINTS "$1"; }
read_uuid_inventory() { lsblk --noheadings --raw --output PATH,UUID; }
read_signatures() { wipefs --no-act --output TYPE --noheadings "$1"; }
read_fs_type() { blkid --output value --match-tag TYPE "$1"; }
read_fs_uuid() { blkid --output value --match-tag UUID "$1"; }
read_mount_uuid() { findmnt --noheadings --raw --output UUID --mountpoint "$MOUNTPOINT"; }
read_mount_type() { findmnt --noheadings --raw --output FSTYPE --mountpoint "$MOUNTPOINT"; }
read_mount_source() { findmnt --noheadings --raw --output SOURCE --mountpoint "$MOUNTPOINT"; }
read_mount_presence() { mountpoint --quiet -- "$MOUNTPOINT"; }
read_submounts() { findmnt --noheadings --raw --output TARGET --submounts --mountpoint "$MOUNTPOINT"; }
read_mountpoint_entries() { ls -A "$MOUNTPOINT"; }
canonical_device() { readlink -f "$1"; }
format_xfs() { mkfs.xfs "$1" >/dev/null; }
mount_xfs() { mount --types xfs "UUID=$1" "$MOUNTPOINT"; }

resolve_device() {
  local wanted=${1//-/} inventory path kind serial extra found= count=0
  inventory=$(read_inventory) || die 'Cannot read the NVMe inventory'
  while read -r path kind serial extra; do
    [[ -n ${path:-} ]] || continue
    [[ -z ${extra:-} ]] || die 'Unexpected block-device inventory fields'
    [[ $kind == disk && $path =~ ^/dev/nvme[0-9]+n[0-9]+$ ]] || continue
    [[ $serial =~ ^vol-?[0-9a-f]{17}$ ]] || continue
    if [[ ${serial//-/} == "$wanted" ]]; then
      found=$path
      ((count += 1))
    fi
  done <<< "$inventory"
  (( count == 1 )) || die "Expected exactly one Nitro disk with EBS serial $1; found $count"
  printf '%s\n' "$found"
}

ensure_unpartitioned() {
  local device=$1 tree first second extra
  tree=$(read_device_tree "$device") || die 'Cannot read the selected device tree'
  read -r first second extra <<< "$tree"
  [[ $first == "$device" && $second == disk && -z ${extra:-} ]] ||
    die 'Selected device is not a whole disk'
  [[ $(printf '%s\n' "$tree" | wc -l | tr -d ' ') == 1 ]] ||
    die 'Selected disk has partitions or child devices; inspect manually'
}

filesystem_state() {
  local device=$1 signatures type uuid status=0
  signatures=$(read_signatures "$device") || die 'Cannot inspect all filesystem signatures'
  signatures=$(printf '%s\n' "$signatures" | sed '/^[[:space:]]*$/d; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [[ -z $signatures ]]; then
    # A missing filesystem UUID must agree with wipefs before first-use format.
    uuid=$(read_fs_uuid "$device" 2>/dev/null) || status=$?
    case "$status" in
      0) die 'blkid reported a filesystem on a disk that wipefs reported blank' ;;
      2) [[ -z $uuid ]] || die 'blkid returned an unexpected UUID with no signature' ;;
      *) die "blkid failed with status $status; disk is not proven blank" ;;
    esac
    printf 'blank\n'
    return
  fi
  [[ $signatures == xfs ]] || die "Unexpected or multiple disk signatures: $signatures"
  type=$(read_fs_type "$device") || die 'Cannot confirm XFS filesystem type'
  [[ $type == xfs ]] || die 'wipefs and blkid disagree on filesystem type'
  uuid=$(read_fs_uuid "$device") || die 'Cannot read XFS filesystem UUID'
  [[ $uuid =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
    die 'Invalid or absent XFS filesystem UUID'
  printf 'xfs:%s\n' "$uuid"
}

ensure_unique_uuid() {
  local device=$1 uuid=$2 inventory path seen_uuid extra found= count=0
  inventory=$(read_uuid_inventory) || die 'Cannot inspect filesystem UUID inventory'
  while read -r path seen_uuid extra; do
    [[ -n ${path:-} ]] || continue
    [[ -z ${extra:-} ]] || die 'Unexpected UUID inventory fields'
    if [[ ${seen_uuid:-} == "$uuid" ]]; then
      found=$path
      ((count += 1))
    fi
  done <<< "$inventory"
  (( count == 1 )) && [[ $found == "$device" ]] ||
    die "Filesystem UUID $uuid is absent, duplicated, or belongs to another device"
}

ensure_mount_state() {
  local device=$1 expected_uuid=${2:-} mounts mounted_uuid mounted_type mounted_source resolved_source resolved_device mount_status=0 presence_status=0
  mounts=$(read_device_mounts "$device") || die 'Cannot inspect selected disk mounts'
  mounts=$(printf '%s\n' "$mounts" | sed '/^[[:space:]]*$/d')
  [[ -z $mounts || $mounts == "$MOUNTPOINT" ]] ||
    die "Selected disk is mounted outside $MOUNTPOINT"

  mounted_uuid=$(read_mount_uuid 2>/dev/null) || mount_status=$?
  if (( mount_status == 0 )); then
    mounted_type=$(read_mount_type) || die 'Cannot read mount filesystem type'
    mounted_source=$(read_mount_source) || die 'Cannot read mount source'
    resolved_source=$(canonical_device "$mounted_source") || die 'Cannot resolve mount source'
    resolved_device=$(canonical_device "$device") || die 'Cannot resolve selected disk'
    [[ -n $expected_uuid && $mounted_uuid == "$expected_uuid" && $mounted_type == xfs && $mounts == "$MOUNTPOINT" && $resolved_source == "$resolved_device" ]] ||
      die "Wrong filesystem mounted at $MOUNTPOINT"
    printf 'mounted\n'
  else
    (( mount_status == 1 )) || die "Cannot inspect mount point (findmnt status $mount_status)"
    if [[ -e $MOUNTPOINT ]]; then
      read_mount_presence || presence_status=$?
      (( presence_status == 32 )) || die "Mount point is occupied or unreadable (mountpoint status $presence_status)"
    fi
    [[ -z $mounts ]] || die 'Selected disk mount and target disagree'
    printf 'unmounted\n'
  fi
}

fstab_entry() {
  printf 'UUID=%s %s xfs defaults,nofail,x-systemd.device-timeout=30s 0 0' "$1" "$MOUNTPOINT"
}

fstab_state() {
  local uuid=$1 entry
  [[ -f $FSTAB && ! -L $FSTAB ]] || die 'Expected a regular /etc/fstab'
  entry=$(fstab_entry "$uuid")
  awk -v wanted="$entry" -v spec="UUID=$uuid" -v target="$MOUNTPOINT" '
    $0 !~ /^[[:space:]]*#/ && NF {
      if ($1 == spec || $2 == target) {
        if ($0 == wanted) exact++
        else conflict++
      }
    }
    END {
      if (conflict || exact > 1) exit 2
      print (exact == 1 ? "exact" : "missing")
    }
  ' "$FSTAB" || die 'Conflicting or duplicate fstab entry for volume UUID or mount point'
}

ensure_empty_mountpoint() {
  local entries
  [[ ! -L /srv && ! -L ${MOUNTPOINT%/*} && ! -L $MOUNTPOINT ]] ||
    die 'Mount path contains a symlink'
  if [[ -e $MOUNTPOINT ]]; then
    [[ -d $MOUNTPOINT ]] || die 'Mount path is not a directory'
    entries=$(read_mountpoint_entries) || die 'Cannot inspect mount path contents'
    [[ -z $entries ]] || die 'Mount path contains root-volume data'
  fi
}

ensure_data_dirs() {
  local path submounts
  submounts=$(read_submounts) || die 'Cannot inspect nested mounts'
  [[ $submounts == "$MOUNTPOINT" ]] || die 'Unexpected nested mount under PostgreSQL data volume'
  for path in "$MOUNTPOINT/data" "$MOUNTPOINT/postgresql-custom"; do
    [[ ! -L $path ]] || die "Persistent path is a symlink: $path"
    if [[ -e $path ]]; then
      [[ -d $path ]] || die "Persistent path is not a directory: $path"
    else
      mkdir -m 0700 "$path"
    fi
  done
}

append_fstab_entry() {
  local uuid=$1 backup
  backup=$(mktemp "${FSTAB}.wallie-backup.XXXXXX") || die 'Cannot stage fstab backup'
  cp -p "$FSTAB" "$backup"
  # Append in place to preserve /etc/fstab's inode, ACLs, xattrs, and SELinux
  # label. Retain the backup on any failure for an operator to inspect.
  if ! printf '\n%s\n' "$(fstab_entry "$uuid")" >> "$FSTAB"; then
    die "fstab write failed; inspect the unchanged-inode file and backup $backup"
  fi
  [[ $(fstab_state "$uuid") == exact ]] ||
    die "fstab verification failed; inspect the file and backup $backup"
  rm -f "$backup"
}

main() {
  local action=${1:-} volume_id=${3:-} final_arg=${5:-} device state uuid mount_state fstab_status
  case "$action" in
    inspect)
      (( $# == 3 )) && [[ ${2:-} == --volume-id ]] || usage ;;
    mount)
      (( $# == 5 )) && [[ ${2:-} == --volume-id && ${4:-} == --expected-uuid ]] || usage
      [[ $final_arg =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
        die 'Expected UUID must be a recorded XFS filesystem UUID' ;;
    initialize)
      (( $# == 5 )) && [[ ${2:-} == --volume-id && ${4:-} == --confirm-format ]] || usage
      [[ $final_arg == "$volume_id" ]] || die 'Formatting confirmation must repeat the exact volume ID' ;;
    *) usage ;;
  esac
  [[ $volume_id =~ ^vol-[0-9a-f]{17}$ ]] || die 'Use an exact 17-digit hexadecimal EBS volume ID'
  require_root

  device=$(resolve_device "$volume_id")
  ensure_unpartitioned "$device"
  state=$(filesystem_state "$device")
  if [[ $action == initialize ]]; then
    [[ $state == blank ]] || die 'Initialize only accepts a completely blank disk; never reformat an existing filesystem'
    [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Blank disk is mounted'
    [[ $(fstab_state UNFORMATTED) == missing ]] || die 'Mount point already has an fstab entry'
    ensure_empty_mountpoint
    # Repeat the signature read immediately before the sole destructive call.
    [[ $(resolve_device "$volume_id") == "$device" ]] || die 'EBS serial changed before formatting'
    ensure_unpartitioned "$device"
    [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Disk mounted before formatting'
    [[ $(filesystem_state "$device") == blank ]] || die 'Disk changed before formatting'
    format_xfs "$device"
    state=$(filesystem_state "$device")
    [[ $state == xfs:* ]] || die 'Formatted filesystem cannot be verified'
  else
    [[ $state == xfs:* ]] || {
      if [[ $action == inspect ]]; then
        [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Blank disk is mounted'
        [[ $(fstab_state UNFORMATTED) == missing ]] || die 'Mount point already has an fstab entry'
        ensure_empty_mountpoint
        printf 'volume_id=%s device=%s serial=%s partitions=none signatures=none filesystem=blank mount=unmounted fstab=missing\n' \
          "$volume_id" "$device" "$volume_id"
        return
      fi
      die 'Disk is blank; use initialize with explicit matching format confirmation'
    }
  fi

  uuid=${state#xfs:}
  if [[ $action == mount ]]; then
    [[ $uuid == "$final_arg" ]] || die 'Existing filesystem UUID differs from the trusted recorded UUID'
  fi
  ensure_unique_uuid "$device" "$uuid"
  mount_state=$(ensure_mount_state "$device" "$uuid")
  fstab_status=$(fstab_state "$uuid")
  if [[ $action == inspect ]]; then
    if [[ $mount_state == unmounted ]]; then ensure_empty_mountpoint; fi
    printf 'volume_id=%s device=%s serial=%s partitions=none signatures=xfs filesystem=xfs uuid=%s mount=%s fstab=%s\n' \
      "$volume_id" "$device" "$volume_id" "$uuid" "$mount_state" "$fstab_status"
    return
  fi

  if [[ $mount_state == unmounted ]]; then
    ensure_empty_mountpoint
    mkdir -p -m 0700 "$MOUNTPOINT"
    [[ $(resolve_device "$volume_id") == "$device" ]] || die 'EBS serial changed before mounting'
    ensure_unpartitioned "$device"
    [[ $(filesystem_state "$device") == "xfs:$uuid" ]] || die 'Filesystem changed before mounting'
    ensure_unique_uuid "$device" "$uuid"
    mount_xfs "$uuid"
    [[ $(ensure_mount_state "$device" "$uuid") == mounted ]] || die 'Mount verification failed'
  fi
  ensure_data_dirs
  if [[ $fstab_status != exact ]]; then
    [[ $(resolve_device "$volume_id") == "$device" ]] || die 'EBS serial changed before fstab update'
    ensure_unpartitioned "$device"
    [[ $(filesystem_state "$device") == "xfs:$uuid" ]] || die 'Filesystem changed before fstab update'
    ensure_unique_uuid "$device" "$uuid"
    [[ $(ensure_mount_state "$device" "$uuid") == mounted ]] || die 'Mount changed before fstab update'
    append_fstab_entry "$uuid"
  fi
  printf 'volume_id=%s device=%s filesystem=xfs uuid=%s mount=mounted fstab=exact\n' \
    "$volume_id" "$device" "$uuid"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
