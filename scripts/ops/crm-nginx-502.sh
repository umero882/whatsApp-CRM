#!/usr/bin/env bash
#
# crm-nginx-502.sh — diagnose and fix 502s on crm.sheger.cloud /
# crm.ethiopianmaids.com, which are served by HOST nginx on 72.60.205.121
# proxying to the Coolify container on 127.0.0.1:8084.
#
# Run it ON THE VPS, by piping it over ssh. The host is 72.60.205.121 —
# do NOT use the `hstgr-mcp` alias, which resolves to srv1413879, the
# SUPABASE VPS, and has no nginx on it:
#
#   ssh 72.60.205.121 'bash -s' -- diagnose   < scripts/ops/crm-nginx-502.sh
#   ssh 72.60.205.121 'bash -s' -- apply      < scripts/ops/crm-nginx-502.sh
#   ssh 72.60.205.121 'bash -s' -- rollback   < scripts/ops/crm-nginx-502.sh
#
# `diagnose` is READ-ONLY. Run it first and read the verdict before `apply`.
# `apply` backs every file up, runs `nginx -t`, and rolls itself back
# automatically if the config does not validate. Nothing is ever restarted —
# only `nginx -s reload`, which is graceful and drops no connections.

set -uo pipefail

MODE="${1:-diagnose}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/nginx-backups/${STAMP}"
BUFFERS_CONF="/etc/nginx/conf.d/crm-proxy-buffers.conf"
SNIPPET="/etc/nginx/snippets/crm-502-maintenance.conf"
MAINT_ROOT="/var/www/crm-maintenance"
MAINT_FILE="${MAINT_ROOT}/_crm_maintenance.html"
INCLUDE_LINE="    include ${SNIPPET};"
VHOST_MATCH='crm\.(sheger\.cloud|ethiopianmaids\.com)'

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mBAD\033[0m  %s\n' "$*"; }

# Every LOADED config file that serves one of the CRM hostnames, resolved to
# its REAL path.
#
# Two traps this avoids:
#
#   1. `grep -r` does not follow symlinks, and /etc/nginx/sites-enabled/* are
#      symlinks into sites-available/. Recursing sites-enabled/ therefore found
#      nothing at all. Driving the list from `nginx -T` (the effective,
#      fully-included config) sidesteps that and also skips sites-available
#      entries that are not enabled and stale backups nginx never loads.
#
#   2. Everything downstream edits these paths in place. Writing through the
#      symlink with `awk > tmp && mv` would REPLACE the symlink with a regular
#      file, leaving sites-available/ holding stale content and the two
#      directories silently diverged. `readlink -f` gives the real file so the
#      symlink structure survives.
crm_vhosts() {
  local loaded f
  loaded="$(nginx -T 2>/dev/null | grep -oP '^# configuration file \K.*(?=:$)' | sort -u)"
  [ -n "$loaded" ] || return 0
  for f in $loaded; do
    [ -f "$f" ] || continue
    grep -qE "server_name[^;]*${VHOST_MATCH}" "$f" && readlink -f "$f"
  done | sort -u
}

# Refuse to run anywhere except the CRM/Coolify box.
#
# The `hstgr-mcp` ssh alias points at srv1413879 — the SUPABASE VPS — which has
# no nginx at all. Running there produced a misleading "no upstream errors"
# verdict on 2026-08-22. The CRM host is 72.60.205.121; connect to it by IP:
#
#   ssh 72.60.205.121 'bash -s' -- diagnose < scripts/ops/crm-nginx-502.sh
assert_crm_host() {
  local problems=0
  if ! command -v nginx >/dev/null 2>&1; then
    bad "nginx is not installed on this host"; problems=1
  fi
  if [ ! -f /etc/nginx/nginx.conf ]; then
    bad "/etc/nginx/nginx.conf does not exist"; problems=1
  fi
  if [ "$problems" -ne 0 ]; then
    echo
    bad "WRONG HOST — this is not the CRM/Coolify VPS."
    echo "       hostname: $(hostname 2>/dev/null)  ip: $(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "       Re-run against 72.60.205.121, NOT the hstgr-mcp alias (that is Supabase):"
    echo "         ssh 72.60.205.121 'bash -s' -- ${MODE} < scripts/ops/crm-nginx-502.sh"
    exit 3
  fi
}

# ---------------------------------------------------------------- diagnose --
diagnose() {
  assert_crm_host

  hr "nginx"
  nginx -v 2>&1
  echo "conf.d included inside http{}: $(grep -c 'include */etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf)"

  hr "CRM vhosts (from the loaded config, via nginx -T)"
  local vhosts
  vhosts="$(crm_vhosts)"
  if [ -z "$vhosts" ]; then
    bad "no LOADED config file matches ${VHOST_MATCH}"
    echo "       server_names nginx actually serves:"
    nginx -T 2>/dev/null | grep -oP '^\s*server_name\s+\K[^;]+' | tr ' ' '\n' | sort -u | sed 's/^/         /'
  else
    echo "$vhosts" | sed 's/^/  /'
  fi

  hr "Current buffer settings (effective values shown; blank = nginx default)"
  echo "  proxy_buffer_size        : $(grep -rhoP 'proxy_buffer_size\s+\K[^;]+' /etc/nginx/ 2>/dev/null | head -1) (default 4k/8k)"
  echo "  proxy_buffers            : $(grep -rhoP 'proxy_buffers\s+\K[^;]+' /etc/nginx/ 2>/dev/null | head -1) (default 8 4k/8k)"
  echo "  large_client_header_buffers: $(grep -rhoP 'large_client_header_buffers\s+\K[^;]+' /etc/nginx/ 2>/dev/null | head -1) (default 4 8k)"

  hr "Upstream target"
  # Guard the empty case: `grep -r PATTERN` with no file argument silently
  # recurses the CURRENT DIRECTORY, which on the wrong host printed unrelated
  # Supabase upstreams and made it look like it had found the CRM vhosts.
  if [ -n "$vhosts" ]; then
    # shellcheck disable=SC2086
    grep -hoP 'proxy_pass\s+\K[^;]+' $vhosts 2>/dev/null | sort -u
  else
    warn "no CRM vhost files — skipping proxy_pass scan"
  fi
  echo "  listeners on 8084:"
  ss -ltnp 2>/dev/null | grep -E ':8084' || warn "nothing is listening on 8084 right now"

  hr "Container"
  docker ps --filter 'name=l13cxwi' --format '  {{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null \
    || warn "docker ps failed"
  echo "  restart count: $(docker inspect --format '{{.RestartCount}}' "$(docker ps -q --filter 'name=l13cxwi' | head -1)" 2>/dev/null || echo '?')"

  hr "nginx error log — 502 root-cause fingerprints (last 20000 lines)"
  local log logs
  logs="$(ls -1 /var/log/nginx/*error*.log 2>/dev/null)"
  [ -z "$logs" ] && bad "no error logs found in /var/log/nginx/"

  local total_big total_refused total_closed total_timeout
  total_big=0; total_refused=0; total_closed=0; total_timeout=0
  for log in $logs; do
    local t
    t=$(tail -n 20000 "$log" 2>/dev/null | grep -c 'too big header')          ; total_big=$((total_big+t))
    t=$(tail -n 20000 "$log" 2>/dev/null | grep -c 'Connection refused')      ; total_refused=$((total_refused+t))
    t=$(tail -n 20000 "$log" 2>/dev/null | grep -c 'prematurely closed')      ; total_closed=$((total_closed+t))
    t=$(tail -n 20000 "$log" 2>/dev/null | grep -c 'upstream timed out')      ; total_timeout=$((total_timeout+t))
  done

  printf '  %-46s %s\n' 'upstream sent too big header  -> 502' "$total_big"
  printf '  %-46s %s\n' 'connect() failed / refused    -> 502' "$total_refused"
  printf '  %-46s %s\n' 'upstream prematurely closed   -> 502' "$total_closed"
  printf '  %-46s %s\n' 'upstream timed out            -> 504' "$total_timeout"

  hr "Most recent 25 upstream errors (verbatim)"
  # shellcheck disable=SC2086
  tail -n 20000 $logs 2>/dev/null \
    | grep -E 'too big header|Connection refused|prematurely closed|upstream timed out' \
    | tail -25

  hr "VERDICT"
  if [ "$total_big" -gt 0 ]; then
    bad "'upstream sent too big header' present -> the authenticated response headers"
    echo "       (long CSP + chunked Supabase sb-*-auth-token Set-Cookie) overflow"
    echo "       proxy_buffer_size. This is EXACTLY the 'works in incognito, 502 when"
    echo "       logged in' symptom. \`apply\` fixes it."
  elif [ "$total_refused" -gt 0 ]; then
    warn "only 'Connection refused' -> the container was down. Cross-check the times"
    echo "       against Coolify deploys; the ~5s swap window per deploy is expected."
  elif [ "$total_closed" -gt 0 ]; then
    warn "'prematurely closed' -> the Node process dropped the connection mid-response"
    echo "       (crash, OOM, or a middleware hang). Buffers are NOT the cause."
  else
    warn "no upstream errors in the retained log — the 502 may predate log rotation."
    echo "       Re-run this while the 502 is reproducible."
  fi
  echo
}

# ------------------------------------------------------------------- apply --
apply() {
  assert_crm_host

  local vhosts
  vhosts="$(crm_vhosts)"
  if [ -z "$vhosts" ]; then
    bad "no CRM vhost found — aborting, nothing changed"; exit 1
  fi

  hr "Backing up to ${BACKUP_DIR}"
  mkdir -p "$BACKUP_DIR"
  # -L dereferences: store real content, never a symlink that would restore
  # as a dangling link. crm_vhosts already resolves, this is belt-and-braces.
  for f in $vhosts; do cp -Lp "$f" "$BACKUP_DIR/$(basename "$f")"; done
  # Record exactly which files were touched, so rollback is unambiguous.
  printf '%s\n' $vhosts > "$BACKUP_DIR/manifest.txt"
  ln -sfn "$BACKUP_DIR" /root/nginx-backups/latest
  ok "backed up: $(wc -l < "$BACKUP_DIR/manifest.txt") vhost file(s)"

  hr "1/3  Proxy + client header buffers (http level)"
  # http-level so it cascades into every server/location without touching the
  # vhosts. 32k comfortably fits the CSP header plus 3-4 chunked Supabase
  # auth cookies; the request-side bump clears the 400 that oversized cookies
  # currently trigger above 8k.
  cat > "$BUFFERS_CONF" <<'EOF'
# Managed by scripts/ops/crm-nginx-502.sh — CRM 502 fix.
#
# Authenticated responses carry a long Content-Security-Policy header plus
# Supabase's chunked `sb-<ref>-auth-token.N` Set-Cookie headers. Together those
# exceed nginx's default 4k/8k proxy_buffer_size, and nginx answers
# "upstream sent too big header" with a 502 — while an incognito window, which
# sends no cookies and gets no Set-Cookie back, works fine.
proxy_buffer_size           32k;
proxy_buffers             8 32k;
proxy_busy_buffers_size     64k;

# Request side: oversized cookie headers returned 400 above ~8k.
large_client_header_buffers 8 32k;
EOF
  ok "wrote ${BUFFERS_CONF}"

  hr "2/3  Maintenance page for the deploy swap window"
  mkdir -p "$MAINT_ROOT"
  cat > "$MAINT_FILE" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Updating — Ethiopian Maids CRM</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b1020; color:#e6e9f2; text-align:center; padding:2rem; }
  .card { max-width:30rem; }
  h1 { font-size:1.35rem; margin:0 0 .5rem; font-weight:650; }
  p { margin:0 0 1.25rem; opacity:.75; }
  .dot { display:inline-block; width:.5rem; height:.5rem; border-radius:50%;
         background:#4ade80; margin-right:.5rem; animation:p 1.4s ease-in-out infinite; }
  @keyframes p { 0%,100%{opacity:1} 50%{opacity:.25} }
  @media (prefers-color-scheme: light) { body { background:#f6f7fb; color:#12172a; } }
</style>
<div class="card">
  <h1><span class="dot"></span>Deploying an update</h1>
  <p>The CRM is restarting and will be back in a few seconds. This page refreshes on its own.</p>
</div>
<script>setTimeout(function(){location.reload()}, 5000)</script>
EOF

  mkdir -p "$(dirname "$SNIPPET")"
  cat > "$SNIPPET" <<EOF
# Managed by scripts/ops/crm-nginx-502.sh
#
# Coolify cannot roll this app (it publishes a host port), so every deploy
# stops the old container before starting the new one and nginx has no
# upstream for ~5s. Serve a friendly 503 instead of a raw nginx 502.
#
# =503 keeps the response honest for monitors and crawlers: a maintenance
# page returned as 200 would get indexed as the real site.
#
# Note: no proxy_intercept_errors here — a 502 the APP itself returns
# (e.g. /api/me/profile on a database error) must pass through untouched.
error_page 502 503 504 =503 /_crm_maintenance.html;
location = /_crm_maintenance.html {
    root      ${MAINT_ROOT};
    internal;
    add_header Cache-Control "no-store" always;
    add_header Retry-After   30         always;
}
EOF
  ok "wrote ${MAINT_FILE} and ${SNIPPET}"

  hr "3/3  Including the snippet in each CRM server block"
  for f in $vhosts; do
    if grep -qF "$SNIPPET" "$f"; then
      ok "$(basename "$f") already includes the snippet — skipped"
      continue
    fi
    # Insert the include immediately after every `server {` opening line in
    # this file. Adding it to the :80 redirect block is harmless.
    # Write back through `cat >` rather than `mv`: that truncates the existing
    # file in place, keeping its inode, mode and owner. `mv` would install a
    # fresh file with umask-default permissions instead.
    awk -v inc="$INCLUDE_LINE" '
      { print }
      /^[[:space:]]*server[[:space:]]*\{[[:space:]]*$/ { print inc }
    ' "$f" > "${f}.new" && cat "${f}.new" > "$f" && rm -f "${f}.new"
    ok "$(basename "$f") patched ($(grep -cF "$SNIPPET" "$f") block(s))"
  done

  hr "Validating"
  if nginx -t 2>&1; then
    nginx -s reload && ok "config valid, nginx reloaded gracefully"
    echo
    echo "  Verify from your machine:"
    echo "    curl -sI https://crm.ethiopianmaids.com/ | head -3"
    echo "  Backup kept at: ${BACKUP_DIR}  (rollback restores it)"
  else
    bad "nginx -t FAILED — rolling back automatically, nothing was reloaded"
    restore_from "$BACKUP_DIR"
    rm -f "$BUFFERS_CONF" "$SNIPPET"
    nginx -t 2>&1 && warn "rolled back to a valid config; running nginx untouched"
    exit 1
  fi
}

restore_from() {
  local dir="$1"
  [ -f "$dir/manifest.txt" ] || { bad "no manifest in $dir"; return 1; }
  while read -r f; do
    [ -n "$f" ] || continue
    cp -a "$dir/$(basename "$f")" "$f" && ok "restored $f"
  done < "$dir/manifest.txt"
}

# ---------------------------------------------------------------- rollback --
rollback() {
  assert_crm_host

  local dir="${2:-/root/nginx-backups/latest}"
  hr "Rolling back from ${dir}"
  restore_from "$dir" || exit 1
  rm -f "$BUFFERS_CONF" "$SNIPPET"
  ok "removed ${BUFFERS_CONF} and ${SNIPPET}"
  if nginx -t 2>&1; then
    nginx -s reload && ok "rolled back and reloaded"
  else
    bad "nginx -t failed AFTER rollback — inspect /etc/nginx manually, do NOT reload"
    exit 1
  fi
}

case "$MODE" in
  diagnose) diagnose ;;
  apply)    apply ;;
  rollback) rollback "$@" ;;
  *) echo "usage: $0 {diagnose|apply|rollback [backup-dir]}" >&2; exit 2 ;;
esac
