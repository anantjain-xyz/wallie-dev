# Staging PostgreSQL data volume

**Prepare the dedicated EBS volume before PostgreSQL starts.** Keep both database files and the Supabase `pgsodium_root.key` on the same durable mount. This procedure creates no database, backup, or secret.

| Host path                                | Future container path      | Contents                              |
| ---------------------------------------- | -------------------------- | ------------------------------------- |
| `/srv/wallie/postgres/data`              | `/var/lib/postgresql/data` | PostgreSQL data and WAL               |
| `/srv/wallie/postgres/postgresql-custom` | `/etc/postgresql-custom`   | Custom configuration and pgsodium key |

The Terraform attachment requests `/dev/sdf`, but Nitro can enumerate it as a different `/dev/nvme*` name after a reboot. The helper matches the **live EBS volume ID** to its NVMe serial, then records the filesystem UUID in `/etc/fstab`. It refuses ambiguous or unsafe devices. [AWS device identity](https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html), [AWS filesystem and UUID guidance](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html).

## Gate and preparation

1. Apply and verify the [Supabase network](AWS-SUPABASE-NETWORK.md), [PostgreSQL host](AWS-POSTGRES-HOST.md), [private shell transcript path](AWS-POSTGRES-SESSION-LOGGING.md), and [exact-instance operator shell](AWS-POSTGRES-OPERATOR-SESSION.md). Stop if any live check fails. No PostgreSQL container may have started on this host.
2. Read `terraform -chdir=infra/aws/staging-postgres output -json data_volume` from the **live** state. Check the volume ID, AZ, attachment to the reviewed host, encryption and KMS key in AWS. Record the exact ID; do not infer it from `/dev/sdf` or an earlier plan.
3. Review the helper at the commit being deployed and run `shasum -a 256 scripts/prepare-aws-postgres-volume.sh` on the workstation. Transfer that exact file to the host through a reviewed channel in the logged operator shell. Install it at a root-owned path and compare its SHA-256 digest there with the workstation copy before execution. The private host has no general internet path. Never put credentials or key material in the transfer or shell transcript.
4. On the host, check `bash`, `lsblk`, `blkid`, `wipefs`, `findmnt`, `mount`, `mountpoint`, `flock`, `udevadm`, `xfsprogs`, and `systemd` tools are present. Keep the shell open and transcript verified during the operation.

```sh
# On the reviewed host, after transferring to /tmp:
sudo install -o root -g root -m 0700 /tmp/prepare-aws-postgres-volume.sh /root/prepare-aws-postgres-volume.sh
sudo sha256sum /root/prepare-aws-postgres-volume.sh # compare with workstation digest
sudo bash /root/prepare-aws-postgres-volume.sh inspect --volume-id 'vol-<live-id>'
```

Review the reported device, serial, signatures, partitions, mounts, and UUID. Stop on any unexpected output. A volume with an existing filesystem must **never** be initialized: formatting it destroys its data.

| Inspected state                                                          | Reviewed action on the host                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| New, blank, unpartitioned volume                                         | `sudo bash /root/prepare-aws-postgres-volume.sh initialize --volume-id 'vol-<live-id>' --confirm-format 'vol-<live-id>'` |
| Existing XFS filesystem with the UUID from the earlier deployment record | `sudo bash /root/prepare-aws-postgres-volume.sh mount --volume-id 'vol-<live-id>' --expected-uuid '<recorded-uuid>'`     |
| Any other signature, partition, mount, or identity                       | Stop and investigate; do not format or force-mount.                                                                      |

For a new volume, record the UUID in canonical lowercase after initialization so later operators have an independent value to compare. If formatting succeeds but the helper stops before mounting, **do not rerun `initialize`**. Preserve the transcript; separately review the exact EBS identity, XFS signature, and UUID, then record that provenance before using `mount --expected-uuid`. An existing filesystem without that record must not be mounted. The `mount` action requires the recorded UUID and rejects a mismatch. The helper holds an exclusive lock through device inspection, formatting, mounting, and `/etc/fstab` verification. A concurrent invocation must stop and be retried after the first completes. It writes one UUID-based `/etc/fstab` entry for `/srv/wallie/postgres`, mounts that path, and creates the two directories. It refuses another fstab source for the same disk, duplicate UUIDs on attached devices, or a wrong mount. Repeat `inspect` and `mount` with the recorded UUID to check idempotence; verify `findmnt` shows the reviewed UUID, XFS, and exact EBS device. After a controlled reboot, repeat the identity and directory checks and confirm the host remains reachable by the private, logged SSM path. A snapshot-derived clone can carry the same filesystem UUID, so UUID alone cannot identify the data volume. [AWS duplicate-UUID guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-booting-from-wrong-volume.html).

## Guard the future database start

Transfer `scripts/check-aws-postgres-mount.sh` beside the installed preparation helper using the same reviewed, root-owned transfer and SHA-256 comparison. After the volume is mounted, run the read-only guard with the **independently recorded** volume ID and lowercase UUID:

```sh
sudo install -o root -g root -m 0700 /tmp/check-aws-postgres-mount.sh /root/check-aws-postgres-mount.sh
sudo sha256sum /root/check-aws-postgres-mount.sh # compare with workstation digest
sudo bash /root/check-aws-postgres-mount.sh \
  --volume-id 'vol-<live-id>' --expected-uuid '<recorded-uuid>'
```

The guard must pass again after a reboot and immediately before every future database start. It checks the exact mounted XFS volume and both persistent directories; it never mounts, formats, repairs, or changes permissions. A failed check blocks startup and requires investigation.

The future systemd-managed database unit must:

- Require `/srv/wallie/postgres` with `RequiresMountsFor=`, bind its lifecycle to that exact mount unit with `BindsTo=` and `After=`, and run the guard in `ExecStartPre=` with recorded values. Verify the generated mount unit name on the host. [systemd unit dependencies](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml).
- Use Docker `--mount type=bind` for **both** paths in the table, without `bind-create-src`; absent source paths must fail startup. Keep Docker's independent restart policy off. [Docker bind mount behavior](https://docs.docker.com/engine/storage/bind-mounts/).
- Set and verify directory access for the pinned database image's UID/GID **after** the guard succeeds. The preparation helper leaves the directories root-owned with mode `0700`.

This guard checks one point in time; it does not supply the service lifecycle, backup, or recovery. Do not start PostgreSQL until continuous WAL archival, base backups, an isolated restore, and a separately recoverable `pgsodium_root.key` are qualified. [Supabase's key recovery warning](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17).
