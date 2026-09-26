#!/usr/bin/env bash

# Prepare only the separately attached staging PostgreSQL EBS volume. No
# database process, container, or key material is created here.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

MOUNTPOINT=/srv/wallie/postgres
FSTAB=/etc/fstab
LOCKDIR=/run/wallie-postgres
LOCKFILE=prepare-volume.lock

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  die 'Usage: prepare-aws-postgres-volume.sh inspect --volume-id vol-<17 hex> | mount --volume-id vol-<17 hex> --expected-uuid <recorded XFS UUID> | initialize --volume-id vol-<17 hex> --confirm-format vol-<same 17 hex>'
}

require_root() { (( EUID == 0 )) || die 'Run as root to inspect the complete block-device signatures and change mounts'; }
lock_directory_identity() { stat -c '%u:%a' "$LOCKDIR"; }
lock_fd() { flock --exclusive --nonblock 9; }
trigger_udev_change() { udevadm trigger --action=change "$1"; }
settle_udev() { udevadm settle --timeout=30; }
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

acquire_volume_lock() {
  local lock_file
  [[ ! -L $LOCKDIR ]] || die 'Volume lock directory is a symlink'
  mkdir -p -m 0700 "$LOCKDIR" || die 'Cannot create private volume lock directory'
  [[ -d $LOCKDIR && ! -L $LOCKDIR ]] || die 'Volume lock directory is invalid'
  [[ $(lock_directory_identity) == 0:700 ]] || die 'Volume lock directory must be root-owned and mode 0700'
  lock_file="$LOCKDIR/$LOCKFILE"
  [[ ! -L $lock_file ]] || die 'Volume lock file is a symlink'
  [[ ! -e $lock_file || -f $lock_file ]] || die 'Volume lock file is not a regular file'
  exec 9>>"$lock_file" || die 'Cannot open volume lock file'
  lock_fd || die 'Another PostgreSQL volume preparation holds the exclusive lock'
}

release_volume_lock() { exec 9>&-; }

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

verify_fstab() { findmnt --verify --tab-file "$FSTAB" >/dev/null; }
read_fstab_entries() {
  findmnt --fstab --all --tab-file "$FSTAB" --noheadings --raw --output SOURCE,TARGET
}
resolve_fstab_tag() {
  # Without --list-one, blkid returns every device sharing a label or UUID.
  blkid --cache-file /dev/null --match-token "$1" --output device
}
canonical_existing_device() { readlink -e "$1"; }
is_block_device() { [[ -b $1 ]]; }
device_identity() { stat -Lc '%t:%T' "$1"; }

active_fstab_count() {
  awk '$0 !~ /^[[:space:]]*#/ && NF { count++ } END { print count + 0 }' "$FSTAB"
}

exact_fstab_entry_count() {
  local entry=$1
  awk -v wanted="$entry" '$0 == wanted { count++ } END { print count + 0 }' "$FSTAB"
}

ensure_fstab_source_unrelated() {
  local source=$1 selected=$2 resolved candidate canonical selected_identity candidate_identity count=0
  case "$source" in
    UUID=*|LABEL=*|PARTUUID=*|PARTLABEL=*)
      resolved=$(resolve_fstab_tag "$source") || die "Cannot resolve fstab tag: $source"
      [[ -n $resolved ]] || die "Fstab tag has no block device: $source"
      ;;
    /dev/*)
      resolved=$source
      ;;
    none|tmpfs|proc|sysfs|devpts|cgroup|cgroup2)
      return
      ;;
    *)
      # Unknown aliases, including bind mounts and remote sources, require a
      # separate review before a database volume is prepared.
      die "Unsupported fstab source: $source"
      ;;
  esac

  selected_identity=$(device_identity "$selected") || die 'Cannot identify selected block device'
  while IFS= read -r candidate; do
    [[ -n $candidate && $candidate == /dev/* ]] || die "Unexpected resolved fstab source: $source"
    canonical=$(canonical_existing_device "$candidate") || die "Unresolvable fstab device: $source"
    is_block_device "$canonical" || die "Fstab source is not a block device: $source"
    candidate_identity=$(device_identity "$canonical") || die "Cannot identify fstab device: $source"
    [[ $candidate_identity != "$selected_identity" ]] ||
      die "Fstab source aliases the PostgreSQL data disk: $source"
    ((count += 1))
  done <<< "$resolved"
  (( count > 0 )) || die "Fstab source has no resolved device: $source"
}

fstab_state() {
  local uuid=$1 selected=$2 entry active entries source target extra exact=0 parsed=0
  [[ -f $FSTAB && ! -L $FSTAB ]] || die 'Expected a regular /etc/fstab'
  entry=$(fstab_entry "$uuid")
  active=$(active_fstab_count) || die 'Cannot read fstab entries'
  if (( active == 0 )); then
    printf 'missing\n'
    return
  fi
  verify_fstab || die 'Fstab parser/verification rejected an existing entry'
  entries=$(read_fstab_entries) || die 'Cannot enumerate parsed fstab entries'
  [[ -n $entries ]] || die 'Fstab contains entries but parser returned none'
  while read -r source target extra; do
    [[ -n ${source:-} && -n ${target:-} && -z ${extra:-} ]] ||
      die 'Malformed parsed fstab entry'
    ((parsed += 1))
    [[ $source != *\\x* && $target != *\\x* ]] ||
      die 'Escaped fstab source or target requires manual review'
    if [[ $target == "$MOUNTPOINT" ]]; then
      [[ $source == "UUID=$uuid" ]] || die 'Conflicting fstab mount target'
      ((exact += 1))
      continue
    fi
    ensure_fstab_source_unrelated "$source" "$selected"
  done <<< "$entries"
  (( parsed == active )) || die 'Fstab parser omitted one or more active entries'
  (( exact <= 1 )) || die 'Duplicate PostgreSQL fstab mount target'
  if (( exact == 1 )); then
    [[ $(exact_fstab_entry_count "$entry") == 1 ]] ||
      die 'PostgreSQL fstab entry differs from the reviewed exact line'
    printf 'exact\n'
  else
    printf 'missing\n'
  fi
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
  local uuid=$1 device=$2 backup
  backup=$(mktemp "${FSTAB}.wallie-backup.XXXXXX") || die 'Cannot stage fstab backup'
  cp -p "$FSTAB" "$backup"
  # Append in place to preserve /etc/fstab's inode, ACLs, xattrs, and SELinux
  # label. Retain the backup on any failure for an operator to inspect.
  if ! printf '\n%s\n' "$(fstab_entry "$uuid")" >> "$FSTAB"; then
    die "fstab write failed; inspect the unchanged-inode file and backup $backup"
  fi
  [[ $(fstab_state "$uuid" "$device") == exact ]] ||
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
  acquire_volume_lock

  device=$(resolve_device "$volume_id")
  ensure_unpartitioned "$device"
  state=$(filesystem_state "$device")
  if [[ $action == initialize ]]; then
    [[ $state == blank ]] || die 'Initialize only accepts a completely blank disk; never reformat an existing filesystem'
    [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Blank disk is mounted'
    [[ $(fstab_state UNFORMATTED "$device") == missing ]] || die 'Mount point already has an fstab entry'
    ensure_empty_mountpoint
    # Repeat the signature read immediately before the sole destructive call.
    [[ $(resolve_device "$volume_id") == "$device" ]] || die 'EBS serial changed before formatting'
    ensure_unpartitioned "$device"
    [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Disk mounted before formatting'
    [[ $(fstab_state UNFORMATTED "$device") == missing ]] || die 'Fstab changed before formatting'
    [[ $(filesystem_state "$device") == blank ]] || die 'Disk changed before formatting'
    format_xfs "$device"
    trigger_udev_change "$device" || die 'udevadm could not trigger the formatted device change'
    settle_udev || die 'udevadm settle failed after formatting; stop before UUID inspection'
    state=$(filesystem_state "$device")
    [[ $state == xfs:* ]] || die 'Formatted filesystem cannot be verified'
  else
    [[ $state == xfs:* ]] || {
      if [[ $action == inspect ]]; then
        [[ $(ensure_mount_state "$device") == unmounted ]] || die 'Blank disk is mounted'
        [[ $(fstab_state UNFORMATTED "$device") == missing ]] || die 'Mount point already has an fstab entry'
        ensure_empty_mountpoint
        printf 'volume_id=%s device=%s serial=%s partitions=none signatures=none filesystem=blank mount=unmounted fstab=missing\n' \
          "$volume_id" "$device" "$volume_id"
        release_volume_lock
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
  fstab_status=$(fstab_state "$uuid" "$device")
  if [[ $action == inspect ]]; then
    if [[ $mount_state == unmounted ]]; then ensure_empty_mountpoint; fi
    printf 'volume_id=%s device=%s serial=%s partitions=none signatures=xfs filesystem=xfs uuid=%s mount=%s fstab=%s\n' \
      "$volume_id" "$device" "$volume_id" "$uuid" "$mount_state" "$fstab_status"
    release_volume_lock
    return
  fi

  if [[ $mount_state == unmounted ]]; then
    ensure_empty_mountpoint
    mkdir -p -m 0700 "$MOUNTPOINT"
    [[ $(resolve_device "$volume_id") == "$device" ]] || die 'EBS serial changed before mounting'
    ensure_unpartitioned "$device"
    [[ $(filesystem_state "$device") == "xfs:$uuid" ]] || die 'Filesystem changed before mounting'
    ensure_unique_uuid "$device" "$uuid"
    [[ $(fstab_state "$uuid" "$device") == "$fstab_status" ]] || die 'Fstab changed before mounting'
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
    [[ $(fstab_state "$uuid" "$device") == missing ]] || die 'Fstab changed before update'
    append_fstab_entry "$uuid" "$device"
  fi
  printf 'volume_id=%s device=%s filesystem=xfs uuid=%s mount=mounted fstab=exact\n' \
    "$volume_id" "$device" "$uuid"
  release_volume_lock
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
