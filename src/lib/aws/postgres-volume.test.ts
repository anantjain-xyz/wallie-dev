import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-postgres-volume.sh", import.meta.url),
);
const volume = "vol-0123456789abcdef0";
const device = "/dev/nvme1n1";
const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const testDirs: string[] = [];

const harness = String.raw`
source "$WALLIE_SCRIPT"
MOUNTPOINT="$TEST_DIR/postgres"
FSTAB="$TEST_DIR/fstab"
require_root() { :; }
read_inventory() { printf '%s\n' "$MOCK_INVENTORY"; }
read_device_tree() { printf '%s\n' "$MOCK_TREE"; }
read_device_mounts() {
  if [[ $MOCK_MOUNTED == 1 ]]; then printf '%s\n' "$MOUNTPOINT"
  else printf '%s\n' "$MOCK_MOUNTS"; fi
}
read_uuid_inventory() {
  if [[ -n $MOCK_UUID_INVENTORY ]]; then printf '%s\n' "$MOCK_UUID_INVENTORY"
  elif [[ $MOCK_FORMATTED == 1 ]]; then printf '%s %s\n' "$MOCK_DEVICE" "$MOCK_UUID"
  else printf '%s\n' "$MOCK_DEVICE"; fi
}
read_signatures() {
  if [[ $MOCK_FORMATTED == 1 ]]; then printf 'xfs\n'
  else printf '%s\n' "$MOCK_SIGNATURES"; fi
}
read_fs_type() { [[ $MOCK_FORMATTED == 1 ]] && printf 'xfs\n' || return 2; }
read_fs_uuid() { [[ $MOCK_FORMATTED == 1 ]] && printf '%s\n' "$MOCK_UUID" || return "$MOCK_BLKID_STATUS"; }
read_mount_uuid() { [[ $MOCK_MOUNTED == 1 ]] && printf '%s\n' "$MOCK_MOUNT_UUID" || return "$MOCK_FINDMNT_STATUS"; }
read_mount_type() { printf 'xfs\n'; }
read_mount_source() { printf '%s\n' "$MOCK_MOUNT_SOURCE"; }
read_mount_presence() { return "$MOCK_MOUNTPOINT_STATUS"; }
read_submounts() {
  printf '%s\n' "$MOUNTPOINT"
  if [[ $MOCK_NESTED == 1 ]]; then printf '%s/data\n' "$MOUNTPOINT"; fi
}
read_mountpoint_entries() {
  if [[ $MOCK_LS_FAIL == 1 ]]; then return 1; fi
  ls -A "$MOUNTPOINT"
}
canonical_device() { printf '%s\n' "$1"; }
verify_fstab() {
  [[ $MOCK_VERIFY_FAIL == 0 ]] || return 1
  awk '$0 !~ /^[[:space:]]*#/ && NF && NF != 6 { bad=1 } END { exit bad }' "$FSTAB"
}
read_fstab_entries() {
  awk -v omit="$MOCK_PARSER_OMIT" '
    $0 !~ /^[[:space:]]*#/ && NF {
      if (omit == 1 && ++count > 1) next
      print $1, $2
    }
  ' "$FSTAB"
}
resolve_fstab_tag() {
  case "$1" in
    UUID="$MOCK_UUID"|LABEL=wallie) printf '%s\n' "$MOCK_DEVICE" ;;
    LABEL=duplicate) printf '/dev/nvme2n1\n%s\n' "$MOCK_DEVICE" ;;
    UUID=other|LABEL=unrelated) printf '/dev/nvme2n1\n' ;;
    *) return 2 ;;
  esac
}
canonical_existing_device() {
  case "$1" in
    /dev/disk/by-id/wallie) printf '%s\n' "$MOCK_DEVICE" ;;
    /dev/missing) return 1 ;;
    *) printf '%s\n' "$1" ;;
  esac
}
is_block_device() { [[ $1 == /dev/* && $1 != /dev/not-block ]]; }
device_identity() {
  if [[ $1 == "$MOCK_DEVICE" ]]; then printf '259:1\n'
  else printf '259:2\n'; fi
}
format_xfs() { printf 'format:%s\n' "$1" >> "$TEST_DIR/calls"; MOCK_FORMATTED=1; }
mount_xfs() { printf 'mount:%s\n' "$1" >> "$TEST_DIR/calls"; MOCK_MOUNTED=1; }
if [[ $MOCK_PRECREATE_MOUNTPOINT == 1 ]]; then mkdir -p "$MOUNTPOINT"; fi
main "$@"
if [[ $MOCK_RERUN == 1 ]]; then main mount --volume-id "$MOCK_VOLUME" --expected-uuid "$MOCK_UUID"; fi
`;

function run(args: string[], overrides: Record<string, string> = {}, fstab = "") {
  const dir = mkdtempSync(join(tmpdir(), "wallie-postgres-volume-"));
  testDirs.push(dir);
  writeFileSync(
    join(dir, "fstab"),
    fstab.replaceAll("/srv/wallie/postgres", join(dir, "postgres")),
  );
  const result = spawnSync("bash", ["-c", harness, "bash", ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      TEST_DIR: dir,
      WALLIE_SCRIPT: script,
      MOCK_VOLUME: volume,
      MOCK_DEVICE: device,
      MOCK_UUID: uuid,
      MOCK_INVENTORY: `${device} disk vol0123456789abcdef0`,
      MOCK_TREE: `${device} disk`,
      MOCK_MOUNTS: "",
      MOCK_UUID_INVENTORY: "",
      MOCK_SIGNATURES: "",
      MOCK_MOUNT_UUID: uuid,
      MOCK_MOUNT_SOURCE: device,
      MOCK_FORMATTED: "0",
      MOCK_MOUNTED: "0",
      MOCK_NESTED: "0",
      MOCK_RERUN: "0",
      MOCK_BLKID_STATUS: "2",
      MOCK_LS_FAIL: "0",
      MOCK_PRECREATE_MOUNTPOINT: "0",
      MOCK_FINDMNT_STATUS: "1",
      MOCK_MOUNTPOINT_STATUS: "32",
      MOCK_VERIFY_FAIL: "0",
      MOCK_PARSER_OMIT: "0",
      ...overrides,
    },
  });
  return {
    ...result,
    calls: existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "",
    fstab: readFileSync(join(dir, "fstab"), "utf8"),
    dataExists: existsSync(join(dir, "postgres", "data")),
    configExists: existsSync(join(dir, "postgres", "postgresql-custom")),
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staging PostgreSQL EBS preparation", () => {
  it("inspects the exact Nitro serial and blank disk without writing", () => {
    const result = run(["inspect", "--volume-id", volume]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `device=${device} serial=${volume} partitions=none signatures=none`,
    );
    expect(result.stdout).toContain("filesystem=blank mount=unmounted fstab=missing");
    expect(result.calls).toBe("");
    expect(result.dataExists).toBe(false);
  });

  it("formats only with repeated exact volume ID, then mounts and persists both directories", () => {
    const result = run(["initialize", "--volume-id", volume, "--confirm-format", volume]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe(`format:${device}\nmount:${uuid}\n`);
    expect(result.fstab).toMatch(
      new RegExp(`UUID=${uuid} .*/postgres xfs defaults,nofail,x-systemd.device-timeout=30s 0 0`),
    );
    expect(result.dataExists).toBe(true);
    expect(result.configExists).toBe(true);
  });

  it("mounts an existing XFS filesystem without formatting and reruns idempotently", () => {
    const result = run(["mount", "--volume-id", volume, "--expected-uuid", uuid], {
      MOCK_FORMATTED: "1",
      MOCK_RERUN: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe(`mount:${uuid}\n`);
    expect(result.fstab.match(new RegExp(`UUID=${uuid}`, "g"))).toHaveLength(1);
  });

  it("requires the trusted recorded UUID before mounting an existing filesystem", () => {
    const missing = run(["mount", "--volume-id", volume], { MOCK_FORMATTED: "1" });
    expect(missing.status).not.toBe(0);
    expect(missing.calls).toBe("");

    const mismatch = run(
      ["mount", "--volume-id", volume, "--expected-uuid", "11111111-1111-1111-1111-111111111111"],
      { MOCK_FORMATTED: "1" },
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("differs from the trusted recorded UUID");
    expect(mismatch.calls).toBe("");
    expect(mismatch.fstab).not.toContain("/postgres");
  });

  it("rejects implicit format and reformat of an existing filesystem", () => {
    const implicit = run(["mount", "--volume-id", volume, "--expected-uuid", uuid]);
    expect(implicit.status).not.toBe(0);
    expect(implicit.calls).toBe("");
    const reformat = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
      MOCK_FORMATTED: "1",
    });
    expect(reformat.status).not.toBe(0);
    expect(reformat.calls).toBe("");
    const wrongConfirmation = run([
      "initialize",
      "--volume-id",
      volume,
      "--confirm-format",
      "vol-11111111111111111",
    ]);
    expect(wrongConfirmation.status).not.toBe(0);
    expect(wrongConfirmation.calls).toBe("");
  });

  it("rejects absent or ambiguous serial identity before format", () => {
    for (const inventory of [
      "/dev/nvme1n1 disk vol01111111111111111",
      `${device} disk vol0123456789abcdef0\n/dev/nvme2n1 disk vol-0123456789abcdef0`,
    ]) {
      const result = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
        MOCK_INVENTORY: inventory,
      });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    }
  });

  it("rejects root-mounted and partitioned devices before format", () => {
    const cases: Record<string, string>[] = [
      { MOCK_MOUNTS: "/" },
      { MOCK_TREE: `${device} disk\n/dev/nvme1n1p1 part` },
    ];
    for (const overrides of cases) {
      const result = run(
        ["initialize", "--volume-id", volume, "--confirm-format", volume],
        overrides,
      );
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    }
  });

  it("rejects unknown or multiple signatures before format", () => {
    for (const signature of ["ext4", "gpt", "xfs\ngpt"]) {
      const result = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
        MOCK_SIGNATURES: signature,
      });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    }
  });

  it("rejects an ambiguous blkid failure and unreadable mountpoint before format", () => {
    const ambiguous = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
      MOCK_BLKID_STATUS: "8",
    });
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("not proven blank");
    expect(ambiguous.calls).toBe("");

    const unreadable = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
      MOCK_PRECREATE_MOUNTPOINT: "1",
      MOCK_LS_FAIL: "1",
    });
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.stderr).toContain("Cannot inspect mount path contents");
    expect(unreadable.calls).toBe("");

    const mountProbeError = run(["initialize", "--volume-id", volume, "--confirm-format", volume], {
      MOCK_FINDMNT_STATUS: "2",
    });
    expect(mountProbeError.status).not.toBe(0);
    expect(mountProbeError.stderr).toContain("Cannot inspect mount point");
    expect(mountProbeError.calls).toBe("");

    for (const status of ["0", "1"]) {
      const occupiedOrUnreadable = run(
        ["initialize", "--volume-id", volume, "--confirm-format", volume],
        { MOCK_PRECREATE_MOUNTPOINT: "1", MOCK_MOUNTPOINT_STATUS: status },
      );
      expect(occupiedOrUnreadable.status).not.toBe(0);
      expect(occupiedOrUnreadable.calls).toBe("");
    }
  });

  it("rejects duplicate UUIDs and a mount backed by the wrong device", () => {
    const duplicate = run(["mount", "--volume-id", volume, "--expected-uuid", uuid], {
      MOCK_FORMATTED: "1",
      MOCK_UUID_INVENTORY: `${device} ${uuid}\n/dev/nvme2n1 ${uuid}`,
    });
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.calls).toBe("");

    const wrongSource = run(["mount", "--volume-id", volume, "--expected-uuid", uuid], {
      MOCK_FORMATTED: "1",
      MOCK_MOUNTED: "1",
      MOCK_MOUNT_SOURCE: "/dev/nvme2n1",
    });
    expect(wrongSource.status).not.toBe(0);
    expect(wrongSource.calls).toBe("");
  });

  it("rejects conflicting fstab entries and nested mounts", () => {
    const conflict = run(
      ["initialize", "--volume-id", volume, "--confirm-format", volume],
      {},
      `UUID=other /srv/wallie/postgres xfs defaults 0 0\n`,
    );
    expect(conflict.status).not.toBe(0);
    expect(conflict.calls).toBe("");
    const nested = run(["mount", "--volume-id", volume, "--expected-uuid", uuid], {
      MOCK_FORMATTED: "1",
      MOCK_NESTED: "1",
    });
    expect(nested.status).not.toBe(0);
  });

  it("rejects aliases for the same EBS disk at other fstab targets", () => {
    for (const source of [
      device,
      "/dev/disk/by-id/wallie",
      `UUID=${uuid}`,
      "LABEL=wallie",
      "LABEL=duplicate",
    ]) {
      const result = run(
        ["mount", "--volume-id", volume, "--expected-uuid", uuid],
        { MOCK_FORMATTED: "1" },
        `${source} /mnt/elsewhere xfs defaults 0 0\n`,
      );
      expect(result.status, `${source}: ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain("aliases the PostgreSQL data disk");
      expect(result.calls).toBe("");
      expect(result.fstab).not.toContain("/postgres");
    }

    const blankDiskAlias = run(
      ["initialize", "--volume-id", volume, "--confirm-format", volume],
      {},
      `${device} /mnt/elsewhere xfs defaults 0 0\n`,
    );
    expect(blankDiskAlias.status).not.toBe(0);
    expect(blankDiskAlias.calls).toBe("");
  });

  it("rejects unresolved, malformed, and omitted fstab entries", () => {
    const cases: Array<{ fstab: string; overrides?: Record<string, string>; error: string }> = [
      {
        fstab: "LABEL=missing /mnt/elsewhere xfs defaults 0 0\n",
        error: "Cannot resolve fstab tag",
      },
      {
        fstab: "/dev/missing /mnt/elsewhere xfs defaults 0 0\n",
        error: "Unresolvable fstab device",
      },
      { fstab: "broken entry\n", error: "parser/verification rejected" },
      {
        fstab: "UUID=other / xfs defaults 0 0\nLABEL=unrelated /mnt/elsewhere xfs defaults 0 0\n",
        overrides: { MOCK_PARSER_OMIT: "1" },
        error: "parser omitted",
      },
    ];
    for (const item of cases) {
      const result = run(
        ["mount", "--volume-id", volume, "--expected-uuid", uuid],
        { MOCK_FORMATTED: "1", ...item.overrides },
        item.fstab,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(item.error);
      expect(result.calls).toBe("");
    }
  });

  it("permits unrelated root fstab sources and an exact existing entry", () => {
    const unrelated = run(
      ["mount", "--volume-id", volume, "--expected-uuid", uuid],
      { MOCK_FORMATTED: "1" },
      "UUID=other / xfs defaults 0 0\n",
    );
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.fstab).toContain(`UUID=${uuid}`);

    const exact = run(
      ["mount", "--volume-id", volume, "--expected-uuid", uuid],
      { MOCK_FORMATTED: "1", MOCK_MOUNTED: "1", MOCK_PRECREATE_MOUNTPOINT: "1" },
      `UUID=${uuid} /srv/wallie/postgres xfs defaults,nofail,x-systemd.device-timeout=30s 0 0\n`,
    );
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.calls).toBe("");
    expect(exact.fstab.match(new RegExp(`UUID=${uuid}`, "g"))).toHaveLength(1);
  });
});
