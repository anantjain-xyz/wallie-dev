import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/check-aws-postgres-mount.sh", import.meta.url),
);
const volume = "vol-0123456789abcdef0";
const device = "/dev/nvme1n1";
const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const testDirs: string[] = [];

const harness = String.raw`
source "$WALLIE_SCRIPT"
MOUNTPOINT="$TEST_DIR/$MOCK_MOUNT_RELATIVE"
require_root() { :; }
read_inventory() {
  [[ $MOCK_INVENTORY_FAIL == 0 ]] || return 1
  printf '%s\n' "$MOCK_INVENTORY"
}
read_device_tree() { printf '%s\n' "$MOCK_TREE"; }
read_signatures() { printf '%s\n' "$MOCK_SIGNATURES"; }
read_fs_type() { [[ $MOCK_BLKID_FAIL == 0 ]] && printf '%s\n' "$MOCK_FS_TYPE" || return 1; }
read_fs_uuid() { [[ $MOCK_BLKID_FAIL == 0 ]] && printf '%s\n' "$MOCK_FS_UUID" || return 1; }
read_uuid_inventory() {
  [[ $MOCK_UUID_INVENTORY_FAIL == 0 ]] || return 1
  printf '%s\n' "$MOCK_UUID_INVENTORY"
}
read_device_mounts() {
  if [[ $MOCK_MOUNTED == 1 ]]; then printf '%s\n' "$MOUNTPOINT"; fi
}
read_mount_uuid() {
  [[ $MOCK_MOUNTED == 1 ]] && printf '%s\n' "$MOCK_MOUNT_UUID" || return 1
}
read_mount_type() { printf '%s\n' "$MOCK_MOUNT_TYPE"; }
read_mount_source() { printf '%s\n' "$MOCK_MOUNT_SOURCE"; }
canonical_device() { printf '%s\n' "$1"; }
read_mount_presence() { return 32; }
read_mount_options() {
  [[ $MOCK_OPTIONS_FAIL == 0 ]] || return 1
  printf '%s\n' "$MOCK_OPTIONS"
}
read_submounts() {
  [[ $MOCK_SUBMOUNTS_FAIL == 0 ]] || return 1
  printf '%s\n' "$MOUNTPOINT"
  if [[ $MOCK_NESTED == 1 ]]; then printf '%s/data\n' "$MOUNTPOINT"; fi
}
path_device_number() {
  [[ $MOCK_STAT_FAIL == 0 ]] || return 1
  if [[ $MOCK_OFF_FILESYSTEM == 1 && $1 == "$MOUNTPOINT/data" ]]; then
    printf '999\n'
  else
    printf '123\n'
  fi
}
main "$@"
`;

function run(
  args = ["--volume-id", volume, "--expected-uuid", uuid],
  overrides: Record<string, string> = {},
  setup?: (dir: string) => void,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wallie-postgres-guard-")));
  testDirs.push(dir);
  mkdirSync(join(dir, "postgres", "data"), { recursive: true });
  mkdirSync(join(dir, "postgres", "postgresql-custom"));
  setup?.(dir);
  const result = spawnSync("bash", ["-c", harness, "bash", ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      WALLIE_SCRIPT: script,
      TEST_DIR: dir,
      MOCK_MOUNT_RELATIVE: "postgres",
      MOCK_INVENTORY: `${device} disk vol0123456789abcdef0`,
      MOCK_INVENTORY_FAIL: "0",
      MOCK_TREE: `${device} disk`,
      MOCK_SIGNATURES: "xfs",
      MOCK_FS_TYPE: "xfs",
      MOCK_FS_UUID: uuid,
      MOCK_BLKID_FAIL: "0",
      MOCK_UUID_INVENTORY: `${device} ${uuid}`,
      MOCK_UUID_INVENTORY_FAIL: "0",
      MOCK_MOUNTED: "1",
      MOCK_MOUNT_UUID: uuid,
      MOCK_MOUNT_TYPE: "xfs",
      MOCK_MOUNT_SOURCE: device,
      MOCK_OPTIONS: "rw,relatime",
      MOCK_OPTIONS_FAIL: "0",
      MOCK_NESTED: "0",
      MOCK_SUBMOUNTS_FAIL: "0",
      MOCK_OFF_FILESYSTEM: "0",
      MOCK_STAT_FAIL: "0",
      ...overrides,
    },
  });
  return { ...result, dir };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staging PostgreSQL runtime mount guard", () => {
  it("accepts the recorded XFS UUID on the uniquely identified mounted EBS disk", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`volume_id=${volume} device=${device} filesystem=xfs`);
    expect(result.stdout).toContain(`uuid=${uuid} mount=${result.dir}/postgres status=ready`);
  });

  it("requires ordered exact identifiers before probing the disk", () => {
    const cases = [
      ["--expected-uuid", uuid, "--volume-id", volume],
      ["--volume-id", "vol-short", "--expected-uuid", uuid],
      ["--volume-id", volume, "--expected-uuid", "not-a-uuid"],
      ["--volume-id", volume],
    ];
    for (const args of cases) {
      const result = run(args);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("rejects uppercase UUID input before any disk probe", () => {
    const result = run(["--volume-id", volume, "--expected-uuid", uuid.toUpperCase()], {
      MOCK_INVENTORY_FAIL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("canonical lowercase recorded XFS filesystem UUID");
    expect(result.stderr).not.toContain("NVMe inventory");
    expect(result.stdout).toBe("");
  });

  it("rejects an absent mount, including a directory on the disposable root disk", () => {
    const result = run(undefined, { MOCK_MOUNTED: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not mounted");
  });

  it.each([
    ["wrong filesystem UUID", { MOCK_FS_UUID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }],
    ["wrong mounted UUID", { MOCK_MOUNT_UUID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }],
    ["wrong mounted source", { MOCK_MOUNT_SOURCE: "/dev/nvme2n1" }],
    ["wrong mounted type", { MOCK_MOUNT_TYPE: "ext4" }],
    ["wrong EBS serial", { MOCK_INVENTORY: `${device} disk volfffffffffffffffff` }],
    [
      "ambiguous EBS serial",
      {
        MOCK_INVENTORY: `${device} disk vol0123456789abcdef0\n/dev/nvme2n1 disk vol0123456789abcdef0`,
      },
    ],
    ["partitioned disk", { MOCK_TREE: `${device} disk\n/dev/nvme1n1p1 part` }],
    [
      "duplicate filesystem UUID",
      { MOCK_UUID_INVENTORY: `${device} ${uuid}\n/dev/nvme2n1 ${uuid}` },
    ],
  ])("rejects %s", (_case, overrides) => {
    const result = run(undefined, overrides);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects a nested mount and any data directory on a different filesystem", () => {
    const cases: Record<string, string>[] = [{ MOCK_NESTED: "1" }, { MOCK_OFF_FILESYSTEM: "1" }];
    for (const overrides of cases) {
      const result = run(undefined, overrides);
      expect(result.status, result.stderr).not.toBe(0);
    }
  });

  it("rejects a symlinked mountpoint, parent, or persistent directory", () => {
    const mountLink = run(undefined, {}, (dir) => {
      rmSync(join(dir, "postgres"), { recursive: true });
      mkdirSync(join(dir, "actual", "data"), { recursive: true });
      mkdirSync(join(dir, "actual", "postgresql-custom"));
      symlinkSync(join(dir, "actual"), join(dir, "postgres"));
    });
    expect(mountLink.status, mountLink.stderr).not.toBe(0);

    const parentLink = run(undefined, { MOCK_MOUNT_RELATIVE: "link/postgres" }, (dir) => {
      mkdirSync(join(dir, "actual", "postgres", "data"), { recursive: true });
      mkdirSync(join(dir, "actual", "postgres", "postgresql-custom"));
      symlinkSync(join(dir, "actual"), join(dir, "link"));
    });
    expect(parentLink.status, parentLink.stderr).not.toBe(0);

    const dataLink = run(undefined, {}, (dir) => {
      rmSync(join(dir, "postgres", "data"), { recursive: true });
      symlinkSync(join(dir, "postgresql-custom"), join(dir, "postgres", "data"));
    });
    expect(dataLink.status, dataLink.stderr).not.toBe(0);
  });

  it("requires both existing persistent directories", () => {
    for (const name of ["data", "postgresql-custom"]) {
      const result = run(undefined, {}, (dir) => {
        rmSync(join(dir, "postgres", name), { recursive: true });
      });
      expect(result.status, result.stderr).not.toBe(0);
      expect(existsSync(join(result.dir, "postgres", name))).toBe(false);
    }
  });

  it.each([
    ["inventory", { MOCK_INVENTORY_FAIL: "1" }],
    ["blkid", { MOCK_BLKID_FAIL: "1" }],
    ["UUID inventory", { MOCK_UUID_INVENTORY_FAIL: "1" }],
    ["mount options", { MOCK_OPTIONS_FAIL: "1" }],
    ["submounts", { MOCK_SUBMOUNTS_FAIL: "1" }],
    ["filesystem stat", { MOCK_STAT_FAIL: "1" }],
  ])("fails closed when the %s probe errors", (_probe, overrides) => {
    const result = run(undefined, overrides);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each(["ro,relatime", "relatime", "rw,ro,relatime"])("rejects mount options %s", (options) => {
    const result = run(undefined, { MOCK_OPTIONS: options });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/read.write|read.only/);
  });
});
