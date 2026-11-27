#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

cd "$(git rev-parse --show-toplevel)"
mode=${1:-all}
case "$mode" in approve|reject|negative|all) ;; *) echo 'Use: bash scripts/bombadil-review/run.sh [all|approve|reject|negative]' >&2; exit 1;; esac

bombadil=$(command -v "${BOMBADIL:-bombadil}") || { echo 'Install Bombadil v0.8.0 or set BOMBADIL' >&2; exit 1; }
chrome=$(command -v "${CHROME:-chromium}") || { echo 'Install Chromium or set CHROME' >&2; exit 1; }
[[ $("$bombadil" --version) == 'bombadil 0.8.0' ]] || { echo 'Expected Bombadil 0.8.0' >&2; exit 1; }
for cmd in node supabase docker psql unshare ip socat; do
  command -v "$cmd" >/dev/null || { echo "Install required tool: $cmd" >&2; exit 1; }
done
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
docker_version=$(docker version --format '{{.Server.Version}}')
[[ $docker_version =~ ^([0-9]+)\. ]] && (( ${BASH_REMATCH[1]} >= 28 )) ||
  { echo 'Use Docker Engine 28 or newer for loopback-only publication' >&2; exit 1; }
unshare -Urn ip link set lo up || { echo 'This fixture requires unprivileged Linux network namespaces' >&2; exit 1; }
[[ -d node_modules/next ]] || { echo 'Run pnpm install --frozen-lockfile first' >&2; exit 1; }

mkdir -p .wallie
results=$(mktemp -d "$PWD/.wallie/bombadil-review.XXXXXXXX")
temp=$(mktemp -d /tmp/wallie-review.XXXXXXXX)
id="wallie-bombadil-${temp##*.}"
app="$temp/app"
project=()
tunnels=()
network=
cleanup() {
  local status=$?
  trap - EXIT
  if (( ${#tunnels[@]} )); then kill "${tunnels[@]}" 2>/dev/null || true; fi
  if (( ${#project[@]} )) && ! "${project[@]}" stop --project-id "$id" --no-backup >/dev/null 2>&1; then
    echo "Cleanup failed: stop the disposable Supabase project $id with --no-backup" >&2
    status=1
  fi
  if [[ -n "$network" ]] && docker network inspect "$network" >/dev/null 2>&1 &&
    ! docker network rm "$network" >/dev/null 2>&1; then
    echo "Cleanup failed: remove the disposable Docker network $id" >&2
    status=1
  fi
  rm -rf "$temp"
  echo "Private results: $results"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$app" "$temp/home"
revision=$(git rev-parse HEAD)
git archive "$revision" | tar -x -C "$app"
ln -s "$PWD/node_modules" "$app/node_modules"
[[ -f "$app/scripts/bombadil-review/review.mjs" ]] || { echo 'The fixture must be present at HEAD' >&2; exit 1; }
sed -i -E \
  -e "s/^project_id = .*/project_id = \"$id\"/" \
  -e '/^(shadow_)?port = /s/5432/5532/' \
  -e 's@^site_url = .*@site_url = "http://localhost:55300"@' \
  -e '/^\[analytics\]/,/^\[/s/^enabled = true/enabled = false/' \
  "$app/supabase/config.toml"
printf 'Wallie %s; %s; %s\n' "$revision" "$("$bombadil" --version)" "$("$chrome" --version)" | tee "$results/versions.txt"
echo "Disposable Supabase project: $id"
network=$(docker network create --driver bridge -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$id")
project=(env -i PATH="$PATH" HOME="$temp/home" SUPABASE_TELEMETRY_DISABLED=1 supabase --workdir "$app" --network-id "$id")
started=$SECONDS
if ! "${project[@]}" start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor >/dev/null 2>&1; then
  echo 'Could not start disposable Supabase; verify Docker and that ports 55320–55329 are free' >&2
  exit 1
fi
if [[ $(docker port "supabase_db_$id") != '5432/tcp -> 127.0.0.1:55322' ||
      $(docker port "supabase_kong_$id") != '8000/tcp -> 127.0.0.1:55321' ||
      $(docker port "supabase_inbucket_$id") != '8025/tcp -> 127.0.0.1:55324' ]]; then
  echo 'Disposable Supabase ports must be published on loopback only' >&2
  exit 1
fi
echo "Disposable Supabase ready in $((SECONDS-started))s"

for port in 55321 55322; do
  socat "UNIX-LISTEN:$temp/$port,mode=0600,fork" "TCP4:127.0.0.1:$port" 2>/dev/null &
  tunnels+=("$!")
done

env -i PATH="$PATH" HOME="$temp/home" LANG=C.UTF-8 SUPABASE_TELEMETRY_DISABLED=1 \
  NEXT_TELEMETRY_DISABLED=1 GIT_ALLOW_PROTOCOL=file \
  unshare -Urnfp --mount-proc --kill-child bash -euc '
    ip link set lo up
    for port in 55321 55322; do
      socat "TCP4-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork" "UNIX-CONNECT:$1/$port" &
    done
    cd "$1/app"
    exec node scripts/bombadil-review/review.mjs "$2" "$3" "$4" "$5"
  ' _ "$temp" "$results" "$mode" "$(realpath "$bombadil")" "$(realpath "$chrome")"
