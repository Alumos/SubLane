#!/usr/bin/env bash
set -euo pipefail
# Releases and images come from this fork so installs and updates stay on its channel.
install_repository=Alumos/SubLane

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Install or update SubLane from a published Docker image or Linux binary.

Usage: bash install.sh [--version VERSION] [--dir DIRECTORY] [--port PORT] [--enable-updates]
                       [--runtime docker|binary] [--proxy none|caddy|nginx]
                       [--domain DOMAIN] [--trusted-proxies CIDRS]
                       [--wait-timeout SECONDS] [--demo] [--non-interactive]
       bash install.sh --update [--dir DIRECTORY] [--version VERSION] [--enable-updates]
                       [--wait-timeout SECONDS] [--non-interactive]

  --update           Update an existing script-managed installation in place
  --enable-updates   Enable owner-only web updates through a systemd user worker
  --version VERSION  Published version, with or without v (default: latest stable,
                     or newest published prerelease when no stable release exists)
  --dir DIRECTORY    Installation directory (default: ./sublane)
  --port PORT        Host port on 127.0.0.1 (default: 8080)
  --runtime MODE     Docker Compose or a Linux binary with a systemd user service
  --proxy PROXY      Generate a Caddyfile or Nginx configuration (default: none)
  --domain DOMAIN    Public HTTPS domain; without one, proxy listens on local HTTP
  --trusted-proxies CIDRS  Proxy source CIDRs as seen by SubLane, comma-separated
  --wait-timeout SECONDS  Startup readiness timeout (default: 90)
  --demo             Install a read-only demo with disposable sample data
  --non-interactive  Use defaults for omitted choices, even with a terminal
  --help             Show this help

An interactive terminal guides choices with Up/Down and Enter (or number keys).
Basic terminals use numbered prompts. Without a terminal, defaults are a normal
instance, Docker and no proxy; pass flags to choose otherwise. Proxy files are
generated for review but are never installed into Caddy or Nginx automatically.

Requires Bash, curl, and sha256sum or shasum.
New installations also require ss or lsof to check the selected backend port
before download and again before deployment; updates reuse the existing port.
Docker mode needs Compose;
binary mode needs Linux and a working systemd user manager.
Automatic version selection also requires jq.
Existing directories require --update, or an interactive update selection.
Updates preserve configuration, proxy files, data and the existing service identity.
Installation-only options cannot be combined with --update.
Export and verify a database backup before updating. Previous program/configuration
files are retained in a private .update-backup.* directory; these are not data backups.
Failed startup never automatically downgrades a potentially migrated database.
Demo mode requires a compatible release and uses the public login demo / sublane-demo.
HELP
}

cleanup() {
  if [[ -n ${install_stage:-} ]]; then rm -rf -- "$install_stage"; fi
  if [[ -n ${install_lock:-} ]]; then rmdir -- "$install_lock"; fi
}

# This is only a snapshot; startup readiness must still catch later bind conflicts.
check_port() {
  local listeners tool status=0
  if command -v ss >/dev/null; then
    tool=ss
    listeners=$(ss -H -ltn "sport = :$install_port" 2>&1) \
      || fail "Could not check 127.0.0.1:$install_port with ss."
  elif command -v lsof >/dev/null; then
    tool=lsof
    listeners=$(lsof -nP -a -iTCP:"$install_port" -sTCP:LISTEN -Fn 2>&1) || status=$?
    # lsof returns 1 with no output when no listener matches; diagnostics indicate a failed check.
    [[ $status == 0 || ( $status == 1 && -z $listeners ) ]] \
      || fail "Could not check 127.0.0.1:$install_port with lsof."
  else
    fail 'Install ss (iproute2) or lsof to check the selected port before deployment.'
  fi
  # Wildcard listeners can block loopback binding; ports on unrelated addresses need not block it.
  if printf '%s\n' "$listeners" | awk -v port="$install_port" -v tool="$tool" '
    {
      address = tool == "ss" ? $4 : substr($0, 2)
      if (address == "127.0.0.1:" port || address == "0.0.0.0:" port ||
          address == "*:" port || address == "[::]:" port || address == ":::" port ||
          address == "[::ffff:127.0.0.1]:" port || address == "::ffff:127.0.0.1:" port)
        occupied = 1
    }
    END { exit !occupied }
  '; then
    fail "127.0.0.1:$install_port is already in use or covered by a wildcard listener. Choose an unused port with --port (for example, --port 8088)."
  fi
}

compose() {
  local directory=$1
  shift
  # Environment interpolation must not select another image, port or existing project.
  SUBLANE_IMAGE="$install_image" SUBLANE_BIND_ADDRESS=127.0.0.1 \
    SUBLANE_PORT="$install_port" SUBLANE_PUBLIC_URL="$install_public_url" \
    SUBLANE_TRUSTED_PROXIES="$install_trusted_proxies" SUBLANE_LOG_LEVEL=info \
    SUBLANE_DEMO="$install_demo" \
    docker compose --project-name "$install_project" --project-directory "$directory" \
    --env-file "$directory/.env" -f "$directory/docker.compose.yaml" "$@" </dev/null
}

prompt_available() {
  [[ ${install_no_prompt:-false} == false ]] && ( : </dev/tty ) 2>/dev/null
}

prompt_choice() {
  local answer
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || fail 'Could not read the terminal choice.'
  printf '%s' "$answer"
}

# Call in command substitution so selector traps stay separate from installer cleanup.
prompt_select() {
  local title=$1 selected=1 key sequence index answer
  shift
  local -a options=("$@")

  if [[ -z ${TERM:-} || $TERM == dumb || $TERM == unknown ]] || ! command -v stty >/dev/null; then
    printf '\n%s\n' "$title" >/dev/tty
    for ((index=0; index<${#options[@]}; index++)); do
      printf '  %d. %s\n' "$((index+1))" "${options[index]}" >/dev/tty
    done
    while true; do
      answer=$(prompt_choice "$title [1-${#options[@]}] (default 1): ")
      answer=${answer:-1}
      if [[ $answer =~ ^[1-9]$ && $answer -le ${#options[@]} ]]; then
        printf '%s' "$answer"
        return
      fi
      printf 'Choose a number from 1 to %s.\n' "${#options[@]}" >/dev/tty
    done
  fi

  # Read keys from the controlling terminal, never from the curl | bash source pipe.
  exec 3<>/dev/tty || fail 'Could not open the terminal selector.'
  # Function locals are unwound before EXIT on errors; keep saved state in the isolated subshell.
  selector_terminal_state=$(stty -g <&3) || fail 'Could not read terminal settings.'
  # Keep terminal cleanup inside this subshell so cancellation also restores echo and the cursor.
  trap 'printf "\033[0m\033[?25h" >&3; stty "$selector_terminal_state" <&3' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  render_options() {
    for ((index=0; index<${#options[@]}; index++)); do
      printf '\r\033[2K' >&3
      if [[ $((index+1)) == "$selected" ]]; then
        if [[ -z ${NO_COLOR+x} ]]; then printf '\033[7m' >&3; fi
        printf '  > %d. %s' "$((index+1))" "${options[index]}" >&3
        printf '\033[0m\n' >&3
      else
        printf '    %d. %s\n' "$((index+1))" "${options[index]}" >&3
      fi
    done
  }

  printf '\n%s\n  Use Up/Down or a number, then Enter to confirm. Esc cancels.\n\033[?25l' "$title" >&3
  render_options
  while true; do
    # Let read manage key input modes; a manually set raw mode would be restored after SIGINT.
    IFS= read -r -s -n 1 key <&3 || fail 'Could not read the terminal selection.'
    case "$key" in
      ''|$'\r') printf '%s' "$selected"; return ;;
      $'\004') fail 'Installation canceled before deployment.' ;;
      $'\033')
        sequence=''
        IFS= read -r -s -n 2 -t 1 sequence <&3 || fail 'Installation canceled before deployment.'
        case "$sequence" in
          '[A'|OA) selected=$(((selected+${#options[@]}-2)%${#options[@]}+1)) ;;
          '[B'|OB) selected=$((selected%${#options[@]}+1)) ;;
        esac
        ;;
      [1-9])
        if [[ $key -le ${#options[@]} ]]; then selected=$key; fi
        ;;
    esac
    printf '\033[%sA' "${#options[@]}" >&3
    render_options
  done
}

validate_domain() {
  [[ ${#install_domain} -le 253 && $install_domain == *.* \
    && $install_domain != .* && $install_domain != *. && $install_domain != *..* ]] \
    || fail 'Use a valid DNS domain for --domain.'
  local label
  local -a labels
  IFS=. read -r -a labels <<< "$install_domain"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && $label =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || fail 'Use a valid DNS domain for --domain.'
  done
}

verify_download() {
  local name=$1 expected actual
  expected=$(awk -v file="$name" '$2 == file { print $1 }' "$install_stage/SHA256SUMS")
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || fail "Release checksums must contain exactly one $name entry."
  actual=$("${install_hash[@]}" "$install_stage/$name")
  [[ ${actual%% *} == "$expected" ]] || fail "$name checksum mismatch; installation stopped."
}

require_demo_support() {
  [[ $install_demo == true ]] || return 0
  # Verified release configuration declares this capability; old releases would silently ignore the flag.
  if ! awk '/^[[:space:]]*SUBLANE_DEMO[:=]/ { supported=1 } END { exit !supported }' "$1" 2>/dev/null; then
    fail "v$install_version does not support demo mode. Choose a compatible release with --version."
  fi
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 --retry 2 \
    --output "$install_stage/$1" "$install_release/$1" || fail "Could not download $1 for v$install_version."
}

validate_version() {
  local version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?$'
  [[ ${#install_version} -lt 100 && $install_version =~ $version_pattern ]] || fail 'Use a canonical version such as 1.2.3 or 1.2.3-rc.1.'
  if [[ $install_version == *-* ]]; then
    local part
    local -a prerelease_parts
    IFS=. read -r -a prerelease_parts <<< "${install_version#*-}"
    for part in "${prerelease_parts[@]}"; do
      [[ ! $part =~ ^0[0-9]+$ ]] || fail 'Numeric prerelease identifiers cannot have leading zeros.'
    done
  fi
}

release_metadata() {
  install_api_status=$(curl --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 --retry 2 --header 'Accept: application/vnd.github+json' \
    --output "$install_stage/releases.json" --write-out '%{http_code}' \
    "https://api.github.com/repos/$install_repository/$1") || fail 'Could not fetch GitHub releases. Retry or pass --version explicitly.'
}

resolve_version() {
  release_metadata releases/latest
  if [[ $install_api_status == 200 ]]; then
    install_version=$(jq -er 'select(.draft == false and .prerelease == false) | .tag_name | select(type == "string")' \
      "$install_stage/releases.json") || fail 'Invalid latest release metadata.'
    install_version=${install_version#v}
    return
  fi
  # Only absence of a stable release permits fallback; rate limits and outages must not change channels.
  [[ $install_api_status == 404 ]] || fail "GitHub latest release request failed (HTTP $install_api_status). Retry or pass --version explicitly."

  local page count candidate published tag newest_date='' newest_tag=''
  for ((page=1; page<=20; page++)); do
    release_metadata "releases?per_page=100&page=$page"
    [[ $install_api_status == 200 ]] || fail "GitHub releases request failed (HTTP $install_api_status)."
    jq -e 'type == "array"' "$install_stage/releases.json" >/dev/null || fail 'Invalid release list.'
    count=$(jq 'length' "$install_stage/releases.json")
    candidate=$(jq -r '[.[] | select(.draft == false and .prerelease == true and (.tag_name | type) == "string" and (.published_at | type) == "string")]
      | max_by(.published_at) | if . == null then empty else [.published_at, .tag_name] | @tsv end' \
      "$install_stage/releases.json")
    if [[ -n $candidate ]]; then
      IFS=$'\t' read -r published tag <<< "$candidate"
      if [[ $published > $newest_date ]]; then
        newest_date=$published
        newest_tag=$tag
      fi
    fi
    if [[ $count -lt 100 ]]; then
      [[ -n $newest_tag ]] || fail 'No published stable or prerelease version is available.'
      install_version=${newest_tag#v}
      return
    fi
  done
  fail 'Release scan limit reached; pass --version explicitly.'
}

generate_proxy_config() {
  case "$install_proxy" in
    none) return ;;
    caddy)
      if [[ -z $install_domain ]]; then
        cat > "$install_stage/Caddyfile" <<CONFIG
http://127.0.0.1 {
    bind 127.0.0.1
    reverse_proxy 127.0.0.1:$install_port
}
CONFIG
      else
        cat > "$install_stage/Caddyfile" <<CONFIG
$install_domain {
    reverse_proxy 127.0.0.1:$install_port
}
CONFIG
      fi
      ;;
    nginx)
      cat > "$install_stage/nginx.conf" <<CONFIG
# Place map inside the Nginx http context. Replace certificate paths if needed.
map \$http_upgrade \$sublane_connection {
    default upgrade;
    ''      close;
}
CONFIG
      local nginx_listen nginx_name
      if [[ -z $install_domain ]]; then
        nginx_listen='127.0.0.1:80'
        nginx_name='_'
      else
        nginx_listen='443 ssl'
        nginx_name=$install_domain
        cat >> "$install_stage/nginx.conf" <<CONFIG

server {
    listen 80;
    server_name $install_domain;
    return 301 https://$install_domain\$request_uri;
}
CONFIG
      fi
      cat >> "$install_stage/nginx.conf" <<CONFIG

server {
    listen $nginx_listen;
    server_name $nginx_name;
CONFIG
      if [[ -n $install_domain ]]; then
        cat >> "$install_stage/nginx.conf" <<CONFIG
    ssl_certificate     /etc/letsencrypt/live/$install_domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$install_domain/privkey.pem;
CONFIG
      fi
      cat >> "$install_stage/nginx.conf" <<CONFIG

    location / {
        proxy_pass http://127.0.0.1:$install_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$sublane_connection;
        proxy_buffering off;
        proxy_read_timeout 650s;
        proxy_send_timeout 650s;
        client_max_body_size 128m;
    }

    location /api/settings/backup/ {
        proxy_pass http://127.0.0.1:$install_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 950s;
        proxy_send_timeout 950s;
        client_max_body_size 256m;
    }
}
CONFIG
      ;;
  esac
}

write_docker_env() {
  cat > "$install_stage/.env" <<ENV
COMPOSE_PROJECT_NAME=$install_project
SUBLANE_IMAGE=$install_image
SUBLANE_BIND_ADDRESS=127.0.0.1
SUBLANE_PORT=$install_port
SUBLANE_PUBLIC_URL=$install_public_url
SUBLANE_TRUSTED_PROXIES=$install_trusted_proxies
SUBLANE_LOG_LEVEL=info
SUBLANE_DEMO=$install_demo
SUBLANE_MAX_REQUEST_BODY_MB=128
ENV
}

write_binary_files() {
  {
    printf 'SUBLANE_ADDR=%q\n' "127.0.0.1:$install_port"
    printf 'SUBLANE_DATA_DIR=%q\n' "$install_dir/data"
    printf 'SUBLANE_PUBLIC_URL=%q\n' "$install_public_url"
    printf 'SUBLANE_TRUSTED_PROXIES=%q\n' "$install_trusted_proxies"
    printf 'SUBLANE_LOG_LEVEL=info\n'
    printf 'SUBLANE_DEMO=%s\n' "$install_demo"
    printf 'SUBLANE_MAX_REQUEST_BODY_MB=128\n'
  } > "$install_stage/sublane.env"
  cat > "$install_stage/start.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
install_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
set -a
. "$install_root/sublane.env"
set +a
exec "$install_root/sublane"
RUN
  chmod 0700 "$install_stage/start.sh"
  cat > "$install_stage/$install_unit" <<UNIT
[Unit]
Description=SubLane instance $install_project
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash "$install_dir/start.sh"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
}

show_configuration() {
  printf '\nInstallation plan: %s v%s in %s\n' "$install_runtime" "$install_version" "$install_dir"
  printf 'Proxy: %s; local port: %s\n' "$install_proxy" "$install_port"
  if [[ $install_demo == true ]]; then
    printf 'Mode: read-only demo. Sample data resets on restart; live API calls are disabled.\n'
  else
    printf 'Mode: normal instance.\n'
  fi
  if [[ $install_runtime == docker ]]; then cat "$install_stage/.env"
  else cat "$install_stage/sublane.env" "$install_stage/$install_unit"
  fi
  case "$install_proxy" in
    caddy) cat "$install_stage/Caddyfile" ;;
    nginx) cat "$install_stage/nginx.conf" ;;
  esac
  if [[ $install_runtime == docker && $install_proxy != none && -z $install_trusted_proxies ]]; then
    printf 'Note: Docker may hide the proxy source IP. Set SUBLANE_TRUSTED_PROXIES after verifying the peer address seen by SubLane.\n'
  fi
  if [[ $install_prompted == true ]]; then
    local answer
    answer=$(prompt_choice 'Proceed with this installation? [y/N]: ')
    [[ $answer == y || $answer == Y ]] || fail 'Installation canceled before deployment.'
  fi
}

install_docker() {
  compose "$install_stage" config --quiet
  printf 'Pulling %s...\n' "$install_image"
  compose "$install_stage" pull || fail 'Image pull failed; no installation was created.'
  check_port
  mkdir -p -- "$(dirname "$install_dir")"
  # Claim the directory atomically only after verification; simultaneous installers must not overwrite it.
  mkdir -- "$install_dir" || fail "Could not create $install_dir; existing files were left unchanged."
  cp "$install_stage/docker.compose.yaml" "$install_stage/.env" "$install_dir/"
  case "$install_proxy" in
    caddy) cp "$install_stage/Caddyfile" "$install_dir/" ;;
    nginx) cp "$install_stage/nginx.conf" "$install_dir/" ;;
  esac
  if ! compose "$install_dir" up --detach --wait --wait-timeout "$install_wait_timeout" --no-build; then
    printf 'Configuration and any container data are retained in the deployment at %s.\n' "$install_dir" >&2
    printf 'Inspect it with: cd %q && docker compose -f docker.compose.yaml logs --tail=100 sublane\n' "$install_dir" >&2
    fail 'SubLane did not become healthy.'
  fi
  printf 'Manage this deployment: cd %q && docker compose -f docker.compose.yaml ps\n' "$install_dir"
}

install_binary() {
  check_port
  mkdir -p -- "$(dirname "$install_dir")"
  mkdir -- "$install_dir" || fail "Could not create $install_dir; existing files were left unchanged."
  cp -R "$install_stage/unpacked/." "$install_dir/"
  cp "$install_stage/sublane.env" "$install_stage/start.sh" "$install_stage/$install_unit" "$install_dir/"
  case "$install_proxy" in
    caddy) cp "$install_stage/Caddyfile" "$install_dir/" ;;
    nginx) cp "$install_stage/nginx.conf" "$install_dir/" ;;
  esac
  mkdir -m 0700 "$install_dir/data"
  if ! systemctl --user link "$install_dir/$install_unit" \
    || ! systemctl --user daemon-reload \
    || ! systemctl --user enable --now "$install_unit"; then
    systemctl --user disable --now "$install_unit" >/dev/null 2>&1 || true
    printf 'Verified binary and configuration are retained at %s.\n' "$install_dir" >&2
    fail 'Could not enable the systemd user service. Review the unit and user manager.'
  fi
  if ! binary_ready; then
    systemctl --user disable --now "$install_unit" >/dev/null 2>&1 || true
    printf 'Verified binary and configuration are retained at %s.\n' "$install_dir" >&2
    fail "The systemd service did not become ready within $install_wait_timeout seconds."
  fi
  printf 'Manage this deployment: systemctl --user status %s\n' "$install_unit"
  printf 'For service availability after logout, check: loginctl show-user %q -p Linger\n' "${USER:-$(id -un)}"
}

binary_ready() {
  local attempt
  for ((attempt=0; attempt<install_wait_timeout; attempt++)); do
    if systemctl --user is-active --quiet "$install_unit" \
      && curl --fail --silent --max-time 2 "http://127.0.0.1:$install_port/readyz" >/dev/null 2>&1; then
      return 0
    fi
    if ((attempt+1 < install_wait_timeout)); then sleep 1; fi
  done
  return 1
}

read_setting() {
  # Configuration is data here: never source a Docker or systemd environment file.
  awk -v key="$2" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      quote = substr(value, 1, 1)
      if ((quote == "\"" || quote == sprintf("%c", 39)) && substr(value, length(value)) == quote)
        value = substr(value, 2, length(value) - 2)
      count++
    }
    END { if (count > 1) exit 1; print value }
  ' "$1" || fail "Duplicate or unreadable $2 setting in $1."
}

load_installation() {
  [[ -d $install_dir && ! -L $install_dir ]] \
    || fail 'Update requires an existing installation directory, not a symlink.'
  command -v awk >/dev/null || fail 'Install awk first.'
  install_dir=$(cd -- "$install_dir" && pwd -P)
  [[ ! -L $install_dir/.updater && ! -L $install_dir/.updater/mailbox ]] \
    || fail 'Update does not follow symlinked worker directories.'
  if [[ -e $install_dir/.updater/compose.yaml || -L $install_dir/.updater/compose.yaml ]]; then
    [[ -f $install_dir/.updater/compose.yaml && ! -L $install_dir/.updater/compose.yaml ]] \
      || fail 'Update does not follow a symlinked worker overlay.'
    command -v jq >/dev/null || fail 'Install jq for the enabled host updater.'
    cmp -s "$install_dir/.updater/compose.yaml" <(online_compose) \
      || fail 'The host-worker overlay was customized; use the manual upgrade procedure.'
  fi
  if [[ -f $install_dir/.env && -f $install_dir/docker.compose.yaml && ! -e $install_dir/sublane.env ]]; then
    local image override
    local -a overrides=("$install_dir"/docker.compose.*.yaml "$install_dir"/docker.compose.*.yml)
    [[ ! -L $install_dir/.env && ! -L $install_dir/docker.compose.yaml ]] \
      || fail 'Update does not follow symlinked installation configuration.'
    install_runtime=docker
    install_project=$(read_setting "$install_dir/.env" COMPOSE_PROJECT_NAME)
    [[ $install_project =~ ^sublane-[a-z0-9_-]+$ ]] \
      || fail 'Update requires the saved Compose project name from a script-managed installation.'
    install_port=$(read_setting "$install_dir/.env" SUBLANE_PORT)
    install_port=${install_port:-8080}
    install_demo=$(read_setting "$install_dir/.env" SUBLANE_DEMO)
    image=$(read_setting "$install_dir/.env" SUBLANE_IMAGE)
    [[ -n $image ]] || fail 'Update requires a saved SUBLANE_IMAGE setting.'
    override=$(read_setting "$install_dir/.env" COMPOSE_FILE)
    [[ -z $override ]] \
      || fail 'Use the manual upgrade procedure for installations using Compose override files.'
    # A restore override may select another SQLite directory even without COMPOSE_FILE in .env.
    for override in "${overrides[@]}"; do
      [[ ! -e $override && ! -L $override ]] \
        || fail "Use the manual upgrade procedure with the saved Compose override: $override."
    done
  elif [[ -f $install_dir/sublane.env && -f $install_dir/start.sh && -x $install_dir/sublane ]]; then
    local name address
    local -a units=("$install_dir"/sublane-*.service)
    [[ ${#units[@]} == 1 && -f ${units[0]} && ! -L ${units[0]} ]] \
      || fail 'Update requires exactly one saved systemd user service unit.'
    for name in sublane.env start.sh sublane LICENSE THIRD_PARTY_NOTICES.md licenses docs .env.example; do
      [[ ! -L $install_dir/$name ]] || fail "Update does not follow symlinked installation file $name."
    done
    install_runtime=binary
    install_unit=${units[0]##*/}
    install_project=${install_unit%.service}
    [[ $install_project =~ ^sublane-[a-z0-9_-]+$ ]] || fail 'Invalid saved systemd service name.'
    address=$(read_setting "$install_dir/sublane.env" SUBLANE_ADDR)
    [[ $address =~ ^(127\.0\.0\.1|0\.0\.0\.0):([1-9][0-9]{0,4})$ ]] \
      || fail 'Update requires the saved IPv4 service address in sublane.env.'
    install_port=${BASH_REMATCH[2]}
    install_demo=$(read_setting "$install_dir/sublane.env" SUBLANE_DEMO)
  else
    fail 'Directory is not a recognized script-managed SubLane installation.'
  fi
  [[ $install_port =~ ^[1-9][0-9]{0,4}$ && $install_port -le 65535 ]] || fail 'Invalid saved service port.'
  install_demo=${install_demo:-false}
  [[ $install_demo == true || $install_demo == false ]] || fail 'Invalid saved SUBLANE_DEMO setting.'
}

prepare_release() {
  local dependency
  for dependency in curl awk mktemp; do
    command -v "$dependency" >/dev/null || fail "Install $dependency first."
  done
  if [[ $install_enable_updates == true ]]; then
    for dependency in jq systemctl uname; do
      command -v "$dependency" >/dev/null || fail "Install $dependency to enable web updates."
    done
    [[ $(uname -s) == Linux && $install_demo != true ]] || fail 'Web updates require a normal Linux installation.'
    systemctl --user show-environment >/dev/null 2>&1 || fail 'A running systemd user manager is required for web updates.'
    case "$install_dir" in
      *'%'*|*'$'*|*'"'*|*$'\\'*) fail 'Web update paths cannot contain %, $, quotes, or backslashes.' ;;
    esac
    local helper
    for helper in .updater .updater/mailbox .updater/install.sh .updater/updater.sh .updater/compose.yaml; do
      [[ ! -L $install_dir/$helper ]] || fail 'Web updates refuse symlinked worker files.'
    done
    [[ ! -e $install_dir/.updater/mailbox/request.json && ! -L $install_dir/.updater/mailbox/request.json ]] \
      || fail 'A web update is already queued.'
  fi
  if [[ -z $install_version ]]; then
    command -v jq >/dev/null || fail 'Install jq for automatic version selection, or pass --version explicitly.'
  fi
  if command -v sha256sum >/dev/null; then
    install_hash=(sha256sum)
  elif command -v shasum >/dev/null; then
    install_hash=(shasum -a 256)
  else
    fail 'Install sha256sum or shasum first.'
  fi
  if [[ $install_runtime == docker ]]; then
    command -v docker >/dev/null || fail 'Install Docker first.'
    docker compose version >/dev/null || fail 'Docker Compose is required.'
    docker info >/dev/null 2>&1 || fail 'Docker is not running or the current user cannot access it.'
  else
    for dependency in tar uname systemctl; do
      command -v "$dependency" >/dev/null || fail "Install $dependency first."
    done
    [[ $(uname -s) == Linux ]] || fail 'Published binary installations require Linux.'
    case "$(uname -m)" in
      x86_64) install_arch=amd64 ;;
      aarch64|arm64) install_arch=arm64 ;;
      *) fail 'Published binaries support Linux amd64 and arm64 only.' ;;
    esac
    systemctl --user show-environment >/dev/null 2>&1 || fail 'A running systemd user manager is required for binary mode.'
  fi
  umask 077
  if [[ $install_update == true ]]; then
    # Same-filesystem staging lets the final rename replace files atomically.
    install_stage=$(mktemp -d "$install_dir/.update-stage.XXXXXXXX")
  else
    install_stage=$(mktemp -d "${TMPDIR:-/tmp}/sublane-install.XXXXXXXX")
  fi
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [[ -z $install_version ]]; then resolve_version; fi
  validate_version
  install_release="https://github.com/$install_repository/releases/download/v$install_version"
  install_image="ghcr.io/alumos/sublane:$install_version"
}

download_release() {
  printf 'Downloading deployment files for v%s...\n' "$install_version"
  if [[ $install_runtime == docker ]]; then
    install_artifact=docker.compose.yaml
  else
    install_artifact="sublane_${install_version}_linux_${install_arch}.tar.gz"
  fi
  download "$install_artifact"
  download SHA256SUMS
  verify_download "$install_artifact"
  if [[ $install_enable_updates == true ]]; then
    local helper
    for helper in install.sh updater.sh; do
      download "$helper"
      verify_download "$helper"
      bash -n "$install_stage/$helper" || fail "Invalid verified $helper."
    done
  fi
  if [[ $install_runtime == docker ]]; then
    require_demo_support "$install_stage/docker.compose.yaml"
  else
    mkdir "$install_stage/unpacked"
    tar -tzf "$install_stage/$install_artifact" > "$install_stage/archive.list" || fail 'Invalid binary archive.'
    local member
    while IFS= read -r member; do
      case "$member" in
        /*|..|../*|*/../*|*/..) fail 'Binary archive contains an unsafe path.' ;;
      esac
    done < "$install_stage/archive.list"
    tar -xzf "$install_stage/$install_artifact" -C "$install_stage/unpacked" || fail 'Could not extract binary archive.'
    [[ -f $install_stage/unpacked/sublane && ! -L $install_stage/unpacked/sublane && -x $install_stage/unpacked/sublane ]] \
      || fail 'Binary archive is missing the executable.'
    require_demo_support "$install_stage/unpacked/.env.example"
  fi
}

update_compose() {
  local directory=$1 variable
  shift
  (
    # Let the saved .env win over unrelated settings inherited from the caller.
    for variable in ${!SUBLANE_@}; do unset "$variable"; done
    unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES
    local -a files=(-f "$directory/docker.compose.yaml")
    if [[ -f $install_dir/.updater/compose.yaml ]]; then files+=(-f "$install_dir/.updater/compose.yaml"); fi
    # Relative bind mounts must resolve against the live deployment, including during pull.
    docker compose --project-name "$install_project" --project-directory "$install_dir" \
      --env-file "$directory/.env" "${files[@]}" "$@" </dev/null
  )
}

online_compose() {
  cat <<COMPOSE
services:
  sublane:
    environment:
      SUBLANE_UPDATE_DIR: /run/sublane-updates
    volumes:
      - type: bind
        source: $(jq -Rn --arg path "$install_dir/.updater/mailbox" '$path')
        target: /run/sublane-updates
COMPOSE
}

enable_online_updates() {
  install_dir=$(cd -- "$install_dir" && pwd -P)
  local private=$install_dir/.updater unit=updater-$install_project.service name
  [[ ! -L $private && ! -L $private/mailbox ]] || fail 'Web updates refuse symlinked worker directories.'
  [[ ! -e $private/mailbox/request.json && ! -L $private/mailbox/request.json ]] || fail 'A web update is already queued.'
  mkdir -p -- "$private/mailbox"
  chmod 0700 "$private"
  # The private parent protects the host; the bind-mounted mailbox supports arbitrary container UIDs.
  chmod 0777 "$private/mailbox"
  for name in install.sh updater.sh; do
    [[ ! -L $private/$name ]] || fail 'Web updates refuse symlinked helper files.'
    cp "$install_stage/$name" "$private/$name"
    chmod 0700 "$private/$name"
  done
  cat > "$private/$unit" <<UNIT
[Unit]
Description=SubLane host updater
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash "$private/updater.sh" --run "$install_dir"
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
  if [[ $install_runtime == docker ]]; then
    online_compose > "$private/compose.yaml"
    update_compose "$install_dir" config --quiet || fail 'Web update Compose configuration is invalid.'
    update_compose "$install_dir" up --detach --wait --wait-timeout "$install_wait_timeout" --no-build \
      || fail 'SubLane did not become ready with the update mailbox.'
  else
    [[ ! -L $install_dir/sublane.env ]] || fail 'Web updates refuse symlinked configuration.'
    awk '!/^[[:space:]]*SUBLANE_UPDATE_DIR[[:space:]]*=/' "$install_dir/sublane.env" > "$private/sublane.env"
    printf '\nSUBLANE_UPDATE_DIR=%q\n' "$private/mailbox" >> "$private/sublane.env"
    mv -- "$private/sublane.env" "$install_dir/sublane.env"
    systemctl --user restart "$install_unit" || fail 'Could not restart SubLane with the update mailbox.'
    binary_ready || fail 'SubLane did not become ready with the update mailbox.'
  fi
  if ! systemctl --user link "$private/$unit" \
    || ! systemctl --user daemon-reload \
    || ! systemctl --user enable "$unit" \
    || ! systemctl --user restart "$unit"; then
    fail 'Could not enable the host updater. Inspect its systemd user unit.'
  fi
  printf '\nWeb updates enabled. Host diagnostics: %s/last.log\n' "$private"
}

update_failed() {
  printf 'Previous files are retained at %s; current configuration and data are retained at %s.\n' \
    "$install_backup" "$install_dir" >&2
  # An attempted startup may already have migrated SQLite; old binaries are not a safe automatic rollback.
  printf 'Inspect the service logs. Database recovery may require restoring a verified pre-update backup.\n' >&2
  fail "$*"
}

update_installation() {
  [[ $install_options == false ]] || fail 'Update preserves existing settings; installation-only options cannot be combined with --update.'
  load_installation
  umask 077
  mkdir -- "$install_dir/.update-lock" || fail 'Another update is in progress, or the update lock could not be created.'
  install_lock=$install_dir/.update-lock
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  prepare_release
  download_release
  printf '\nUpdate plan: %s v%s in %s; existing port: %s\n' \
    "$install_runtime" "$install_version" "$install_dir" "$install_port"
  printf 'Existing settings, proxy files and data will be preserved. Export and verify a database backup before updating.\n'
  if prompt_available; then
    local answer
    answer=$(prompt_choice 'Proceed with this update? [y/N]: ')
    [[ $answer == y || $answer == Y ]] || fail 'Update canceled before deployment.'
  fi
  if [[ $install_runtime == docker ]]; then
    # Preserve operator changes to Compose; only the pinned image setting changes.
    cp "$install_dir/docker.compose.yaml" "$install_stage/docker.compose.yaml"
    awk -v image="$install_image" '
      /^[[:space:]]*SUBLANE_IMAGE[[:space:]]*=/ { print "SUBLANE_IMAGE=" image; next }
      { print }
    ' "$install_dir/.env" > "$install_stage/.env"
    update_compose "$install_stage" config --quiet || fail 'Updated Compose configuration is invalid; existing files were left unchanged.'
    local configured_image
    configured_image=$(update_compose "$install_stage" config --images sublane) \
      || fail 'Could not resolve the SubLane image from the existing Compose configuration.'
    [[ $configured_image == "$install_image" ]] \
      || fail 'The existing Compose service does not use the selected image. Review its SUBLANE_IMAGE interpolation.'
    update_compose "$install_stage" pull || fail 'Image pull failed; existing files were left unchanged.'
    install_backup=$(mktemp -d "$install_dir/.update-backup.XXXXXXXX")
    cp -p "$install_dir/.env" "$install_dir/docker.compose.yaml" "$install_backup/"
    mv -- "$install_stage/.env" "$install_dir/.env" || update_failed 'Could not replace the image setting.'
    update_compose "$install_dir" up --detach --wait --wait-timeout "$install_wait_timeout" --no-build \
      || update_failed 'Updated SubLane did not become healthy.'
  else
    install_backup=$(mktemp -d "$install_dir/.update-backup.XXXXXXXX")
    cp -p "$install_dir/sublane" "$install_dir/sublane.env" "$install_dir/start.sh" "$install_dir/$install_unit" "$install_backup/"
    local name
    for name in LICENSE THIRD_PARTY_NOTICES.md licenses docs .env.example; do
      if [[ -e $install_stage/unpacked/$name ]]; then
        if [[ -e $install_dir/$name ]]; then cp -pR "$install_dir/$name" "$install_backup/"; fi
        cp -R "$install_stage/unpacked/$name" "$install_dir/" || update_failed "Could not update packaged $name."
      fi
    done
    mv -- "$install_stage/unpacked/sublane" "$install_dir/sublane" || update_failed 'Could not replace the executable.'
    systemctl --user restart "$install_unit" || update_failed 'Could not restart the existing systemd user service.'
    binary_ready || update_failed "Updated systemd service did not become ready within $install_wait_timeout seconds."
  fi
  printf '\nUpdate complete: %s\nPrevious files: %s\n' "$install_dir" "$install_backup"
  if [[ $install_enable_updates == true ]]; then enable_online_updates; fi
}

main() {
  install_version=''
  install_dir=$PWD/sublane
  install_port=8080
  install_wait_timeout=90
  install_runtime=''
  install_demo=''
  install_proxy=''
  install_domain=''
  install_trusted_proxies=''
  install_no_prompt=false
  install_prompted=false
  install_update=false
  install_enable_updates=false
  install_options=false
  install_lock=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version|--dir|--port|--runtime|--proxy|--domain|--trusted-proxies|--wait-timeout)
        [[ $# -ge 2 && -n $2 ]] || fail "Missing value for $1."
        case "$1" in
          --port|--runtime|--proxy|--domain|--trusted-proxies) install_options=true ;;
        esac
        case "$1" in
          --version) install_version=${2#v}; validate_version ;;
          --dir) install_dir=$2 ;;
          --port) install_port=$2 ;;
          --runtime) install_runtime=$2 ;;
          --proxy) install_proxy=$2 ;;
          --domain) install_domain=$2 ;;
          --trusted-proxies) install_trusted_proxies=$2 ;;
          --wait-timeout) install_wait_timeout=$2 ;;
        esac
        shift 2
        ;;
      --non-interactive) install_no_prompt=true; shift ;;
      --update) install_update=true; shift ;;
      --enable-updates) install_enable_updates=true; shift ;;
      --demo) install_demo=true; install_options=true; shift ;;
      --help|-h) usage; return ;;
      *) fail "Unknown argument: $1. Use --help." ;;
    esac
  done

  [[ $install_wait_timeout =~ ^[1-9][0-9]{0,2}$ && $install_wait_timeout -le 300 ]] \
    || fail 'Startup wait timeout must be 1 to 300 seconds.'
  [[ $install_dir != *$'\n'* && $install_dir != *$'\r'* ]] || fail 'Directory cannot contain line breaks.'
  [[ $install_dir == /* ]] || install_dir=$PWD/$install_dir
  # A trailing slash hides a directory symlink from Bash's -L check.
  while [[ $install_dir != / && $install_dir == */ ]]; do install_dir=${install_dir%/}; done
  if [[ $install_update == false && $install_options == false && -d $install_dir && ! -L $install_dir ]] && prompt_available; then
    local choice
    choice=$(prompt_select 'Existing installation' 'Update existing instance' 'Cancel')
    [[ $choice == 1 ]] || fail 'Update canceled before deployment.'
    install_update=true
  fi
  if [[ $install_update == true ]]; then
    update_installation
    return
  fi

  if [[ -z $install_runtime ]] && prompt_available; then
    local choice
    choice=$(prompt_select 'Runtime' 'Docker Compose' 'Linux binary')
    case "$choice" in
      ''|1) install_runtime=docker ;;
      2) install_runtime=binary ;;
      *) fail 'Choose Docker (1) or Linux binary (2).' ;;
    esac
    install_prompted=true
  fi
  install_runtime=${install_runtime:-docker}
  [[ $install_runtime == docker || $install_runtime == binary ]] || fail 'Use --runtime docker or binary.'

  if [[ -z $install_demo ]] && prompt_available; then
    local choice
    choice=$(prompt_select 'Instance mode' 'Normal instance' 'Read-only demo')
    case "$choice" in
      ''|1) install_demo=false ;;
      2) install_demo=true ;;
      *) fail 'Choose a normal instance (1) or read-only demo (2).' ;;
    esac
    install_prompted=true
  fi
  install_demo=${install_demo:-false}

  if [[ -z $install_proxy ]] && prompt_available; then
    local choice
    choice=$(prompt_select 'Reverse proxy' 'None' 'Caddy' 'Nginx')
    case "$choice" in
      ''|1) install_proxy=none ;;
      2) install_proxy=caddy ;;
      3) install_proxy=nginx ;;
      *) fail 'Choose no proxy (1), Caddy (2), or Nginx (3).' ;;
    esac
    install_prompted=true
  fi
  install_proxy=${install_proxy:-none}
  [[ $install_proxy == none || $install_proxy == caddy || $install_proxy == nginx ]] || fail 'Use --proxy none, caddy, or nginx.'
  if [[ $install_proxy != none && -z $install_domain ]] && prompt_available; then
    printf 'Public HTTPS domain (blank for local HTTP only): ' >/dev/tty
    IFS= read -r install_domain </dev/tty || fail 'Could not read the public domain.'
    install_prompted=true
  fi
  if [[ $install_proxy == none ]]; then
    [[ -z $install_domain && -z $install_trusted_proxies ]] || fail '--domain and --trusted-proxies require a reverse proxy.'
  elif [[ -n $install_domain ]]; then
    validate_domain
  fi
  if [[ -n $install_trusted_proxies ]]; then
    local cidr
    local -a cidrs
    IFS=, read -r -a cidrs <<< "$install_trusted_proxies"
    for cidr in "${cidrs[@]}"; do
      [[ $cidr =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ ]] || fail 'Use comma-separated IP CIDRs for --trusted-proxies.'
    done
  elif [[ $install_runtime == binary && $install_proxy != none ]]; then
    install_trusted_proxies=127.0.0.1/32
  fi
  install_public_url=''
  if [[ -n $install_domain ]]; then install_public_url="https://$install_domain"; fi

  [[ $install_port =~ ^[1-9][0-9]{0,4}$ ]] || fail 'Port must be an integer from 1 to 65535.'
  [[ $install_port -le 65535 ]] || fail 'Port must be an integer from 1 to 65535.'
  if [[ $install_runtime == binary ]]; then
    case "$install_dir" in
      *'%'*|*'$'*|*'"'*|*$'\\'*) fail 'Binary installation directory cannot contain %, $, quotes, or backslashes.' ;;
    esac
  fi
  [[ ! -e $install_dir && ! -L $install_dir ]] || fail "Directory already exists: $install_dir. Use --update for a script-managed installation. Configuration and data were left unchanged."

  check_port
  prepare_release
  # Persist a distinct project name so a same-named directory cannot reuse another instance's volume.
  install_project="sublane-$RANDOM-$RANDOM-$$"

  download_release
  if [[ $install_runtime == docker ]]; then
    write_docker_env
  else
    install_unit="$install_project.service"
    write_binary_files
  fi
  generate_proxy_config
  show_configuration
  if [[ $install_runtime == docker ]]; then install_docker; else install_binary; fi
  if [[ $install_enable_updates == true ]]; then enable_online_updates; fi
  printf '\nInstallation complete: %s\n' "$install_dir"
  if [[ $install_proxy == none ]]; then
    if [[ $install_demo == true ]]; then
      printf 'Open http://127.0.0.1:%s and choose Explore demo.\n' "$install_port"
    else
      printf 'Open http://127.0.0.1:%s to create the administrator.\n' "$install_port"
    fi
  else
    local proxy_file=${install_proxy/caddy/Caddyfile}
    [[ $install_proxy != nginx ]] || proxy_file=nginx.conf
    if [[ -n $install_domain ]]; then
      printf 'Review %s, install it in %s, then open %s.\n' "$proxy_file" "$install_proxy" "$install_public_url"
    else
      printf 'Review %s, install it in %s, then open http://127.0.0.1.\n' "$proxy_file" "$install_proxy"
    fi
    if [[ $install_runtime == docker && -z $install_trusted_proxies ]]; then
      printf 'Set SUBLANE_TRUSTED_PROXIES to the proxy peer address seen inside the container before public access.\n'
    fi
  fi
  if [[ $install_demo == true ]]; then
    printf 'Demo login: demo / sublane-demo. This instance is read-only and resets sample data on restart.\n'
  fi
}

# Invoke only after the complete function definition has arrived when used through curl | bash.
main "$@"
