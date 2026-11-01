#!/usr/bin/env bash
set -euo pipefail

publish_state() {
  local state=$1 temporary
  temporary=$(mktemp "$mailbox/.status.XXXXXXXX")
  jq -n --arg id "$request_id" --arg version "$request_version" --arg status "$state" \
    --argjson updated_at "$(date +%s)" \
    '{id:$id,version:$version,status:$status,updated_at:$updated_at}' > "$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$mailbox/status.json"
}

heartbeat() {
  local temporary
  while true; do
    temporary=$(mktemp "$mailbox/.heartbeat.XXXXXXXX")
    printf 'ready\n' > "$temporary"
    chmod 0644 "$temporary"
    mv -f -- "$temporary" "$mailbox/heartbeat"
    sleep 2
  done
}

valid_job() {
  jq -e '
    type == "object" and keys == ["id","status","updated_at","version"] and
    (.id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.version | type == "string" and test("^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$")) and
    (.updated_at | type == "number" and . > 0 and floor == .) and
    (.status == "queued" or .status == "running" or .status == "succeeded" or .status == "failed" or .status == "interrupted")
  ' "$1" >/dev/null 2>&1
}

is_upgrade() {
  local installed
  if [[ -f $installation/sublane.env && -x $installation/sublane ]]; then
    installed=$("$installation/sublane" --version) || return 1
  elif [[ -f $installation/.env && ! -L $installation/.env ]]; then
    installed=$(awk -F= '$1 == "SUBLANE_IMAGE" { count++; value=$2 } END { if(count != 1) exit 1; print value }' "$installation/.env") || return 1
    [[ $installed == ghcr.io/murongg/sublane:* ]] || return 1
    installed=${installed#ghcr.io/murongg/sublane:}
  else
    return 1
  fi
  jq -ne --arg current "$installed" --arg target "$request_version" '
    ($current | test("^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$")) and
    (($target | split(".") | map(tonumber)) > ($current | split(".") | map(tonumber)))
  ' >/dev/null
}

cleanup() {
  if [[ -n ${heartbeat_pid:-} ]]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi
  rm -f -- "$mailbox/heartbeat" "$private/snapshot" "$private/worker.lock/pid"
  rmdir -- "$private/worker.lock" 2>/dev/null || true
}

run_worker() {
  [[ $# == 2 && $1 == --run && -d $2 && ! -L $2 ]] || { echo 'Usage: updater.sh --run INSTALLATION_DIRECTORY' >&2; exit 1; }
  installation=$(cd -- "$2" && pwd -P)
  private=$installation/.updater
  mailbox=$private/mailbox
  [[ -d $private && ! -L $private && -d $mailbox && ! -L $mailbox \
    && -f $private/install.sh && ! -L $private/install.sh ]] || exit 1
  command -v jq >/dev/null || exit 1
  umask 077
  if ! mkdir "$private/worker.lock" 2>/dev/null; then
    [[ -d $private/worker.lock && ! -L $private/worker.lock && -f $private/worker.lock/pid ]] || exit 1
    local previous_pid
    read -r previous_pid < "$private/worker.lock/pid"
    [[ $previous_pid =~ ^[1-9][0-9]*$ ]] || exit 1
    if kill -0 "$previous_pid" 2>/dev/null; then exit 1; fi
    rm -- "$private/worker.lock/pid"
    rmdir -- "$private/worker.lock"
    mkdir "$private/worker.lock"
  fi
  printf '%s\n' "$$" > "$private/worker.lock/pid"
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  # Never replay an installer that may already have migrated the database.
  if [[ -f $mailbox/status.json && ! -L $mailbox/status.json ]] \
    && head -c 2049 "$mailbox/status.json" > "$private/snapshot" \
    && valid_job "$private/snapshot"; then
    request_id=$(jq -r .id "$private/snapshot")
    request_version=$(jq -r .version "$private/snapshot")
    if [[ $(jq -r .status "$private/snapshot") == running ]]; then publish_state interrupted; fi
    if [[ -f $mailbox/request.json && ! -L $mailbox/request.json ]] \
      && [[ $(head -c 2049 "$mailbox/request.json" | jq -r '.id // empty' 2>/dev/null) == "$request_id" ]]; then
      rm -f -- "$mailbox/request.json"
    fi
  fi
  heartbeat &
  heartbeat_pid=$!
  while true; do
    if [[ -e $mailbox/request.json || -L $mailbox/request.json ]]; then
      if [[ ! -f $mailbox/request.json || -L $mailbox/request.json ]] \
        || ! head -c 2049 "$mailbox/request.json" > "$private/snapshot" \
        || [[ $(wc -c < "$private/snapshot") -gt 2048 ]] \
        || ! valid_job "$private/snapshot" \
        || [[ $(jq -r .status "$private/snapshot") != queued ]]; then
        rm -f -- "$mailbox/request.json"
      else
        request_id=$(jq -r .id "$private/snapshot")
        request_version=$(jq -r .version "$private/snapshot")
        publish_state running
        # Arguments are fixed; the only untrusted value is a validated stable version.
        if ! is_upgrade; then
          printf 'Update refused: the target must be a newer stable version of this installation.\n' > "$private/last.log"
          publish_state failed
        elif bash "$private/install.sh" --update --dir "$installation" --version "$request_version" --non-interactive \
          > "$private/last.log" 2>&1; then
          publish_state succeeded
        else
          publish_state failed
        fi
        rm -f -- "$mailbox/request.json"
      fi
    fi
    sleep 1
  done
}

run_worker "$@"
