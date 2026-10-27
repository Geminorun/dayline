#!/usr/bin/env bash
# This script uses an already pulled image. remote.sh handles registry credentials separately.
set -Eeuo pipefail
umask 077
dayline_bundle="$(realpath "${1:?Expected deployment bundle}")"
dayline_root="${DAYLINE_DEPLOY_ROOT:-$HOME/dayline}"
mkdir -p "$dayline_root/releases" "$dayline_root/backups"
chmod 700 "$dayline_root" "$dayline_root/releases" "$dayline_root/backups"
exec 9> "$dayline_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
for dayline_command in docker curl ss; do command -v "$dayline_command" >/dev/null; done
dayline_compose_version="$(docker compose version --short)"
[[ "$(printf '%s\n' 2.30.0 "${dayline_compose_version#v}" | sort -V | head -n1)" == 2.30.0 ]] || {
  echo 'Docker Compose >= 2.30.0 is required for literal env-file values.' >&2; exit 1;
}
export DAYLINE_IMAGE SITE_URL RELEASE_REVISION
DAYLINE_IMAGE="$(cat "$dayline_bundle/image.ref")"
SITE_URL="$(cat "$dayline_bundle/site.url")"
RELEASE_REVISION="$(cat "$dayline_bundle/revision")"
[[ "$RELEASE_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid revision.' >&2; exit 1; }
dayline_release="$(mktemp -d "$dayline_root/releases/$RELEASE_REVISION.XXXXXXXX")"
cp "$dayline_bundle/compose.production.yaml" "$dayline_release/compose.production.yaml"
dayline_previous="$(readlink -f "$dayline_root/current" || true)"
dayline_stopped=false
dayline_migration_started=false
dayline_started=false
dayline_compose() {
  env -u DAYLINE_IMAGE -u DAYLINE_APP_PORT -u DAYLINE_DB_NETWORK -u DAYLINE_PROXY_NETWORK -u DAYLINE_HTTP_PORT -u DAYLINE_HTTPS_PORT -u DAYLINE_NGINX_BIND docker compose --project-name "$DEPLOY_PROJECT" --env-file "$dayline_release/.deploy.env" \
    -f "$dayline_release/compose.production.yaml" "$@"
}
dayline_old_compose() {
  env -u DAYLINE_IMAGE -u DAYLINE_APP_PORT -u DAYLINE_DB_NETWORK -u DAYLINE_PROXY_NETWORK -u DAYLINE_HTTP_PORT -u DAYLINE_HTTPS_PORT -u DAYLINE_NGINX_BIND docker compose --project-name "$DEPLOY_PROJECT" --env-file "$dayline_previous/.deploy.env" \
    -f "$dayline_previous/compose.production.yaml" "$@"
}
dayline_failure() {
  local dayline_code=$?
  trap - EXIT
  if [[ "$dayline_code" != 0 ]]; then
    if [[ "$dayline_started" == true ]]; then dayline_compose stop app gateway >/dev/null 2>&1 || true; fi
    if [[ "$dayline_stopped" == true && "$dayline_migration_started" == false ]]; then
      dayline_old_compose up -d --no-deps --wait >/dev/null 2>&1 || true
    fi
    echo "Deployment failed. Private evidence: $dayline_release" >&2
    if [[ "$dayline_migration_started" == true ]]; then
      echo 'Migration was attempted. No database restore or automatic old-image rollback was performed; inspect the release before reopening.' >&2
    fi
  fi
  exit "$dayline_code"
}
trap dayline_failure EXIT
dayline_render() {
  docker run --rm --user "$(id -u):$(id -g)" \
    --env SITE_URL --env DAYLINE_IMAGE --env RELEASE_REVISION --env DAYLINE_PROXY_IP \
    --volume "$dayline_bundle:/input:ro" --volume "$dayline_release:/output" \
    "$DAYLINE_IMAGE" node scripts/deploy/config.mjs /input/app.env /output
}
export DAYLINE_PROXY_IP=''
dayline_render
# Read literal values without evaluating shell syntax in any configuration value.
while IFS='=' read -r dayline_key dayline_value; do export "$dayline_key=$dayline_value"; done < "$dayline_release/.deploy.env"
if [[ -n "$dayline_previous" && -f "$dayline_previous/.deploy.env" ]]; then
  for dayline_key in DEPLOY_PROJECT POSTGRES_CONTAINER POSTGRES_DB POSTGRES_USER DAYLINE_DB_NETWORK; do
    dayline_old_value="$(sed -n "s/^$dayline_key=//p" "$dayline_previous/.deploy.env")"
    [[ "${!dayline_key}" == "$dayline_old_value" ]] || {
      echo "Database target changed: $dayline_key. Perform an explicit database move separately." >&2; exit 1;
    }
  done
fi
for dayline_network in "$DAYLINE_DB_NETWORK" "$DAYLINE_PROXY_NETWORK"; do
  if ! docker network inspect "$dayline_network" >/dev/null 2>&1; then
    docker network create --label me.mindreview.dayline.project="$DEPLOY_PROJECT" "$dayline_network" >/dev/null
  fi
  [[ "$(docker network inspect --format '{{index .Labels "me.mindreview.dayline.project"}}' "$dayline_network")" == "$DEPLOY_PROJECT" ]] || {
    echo 'The deployment network name belongs to another configuration.' >&2; exit 1;
  }
done
[[ "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER")" == true ]] || {
  echo 'The configured PostgreSQL container must already be running.' >&2; exit 1;
}
if ! docker inspect --format "{{with index .NetworkSettings.Networks \"$DAYLINE_DB_NETWORK\"}}{{range .Aliases}}{{println .}}{{end}}{{end}}" "$POSTGRES_CONTAINER" | grep -qx dayline-postgres; then
  docker network connect --alias dayline-postgres "$DAYLINE_DB_NETWORK" "$POSTGRES_CONTAINER"
fi
dayline_proxy_subnet="$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$DAYLINE_PROXY_NETWORK")"
[[ "$dayline_proxy_subnet" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo 'Expected an IPv4 proxy subnet.' >&2; exit 1; }
sed -i "s|^TRUST_PROXY=$|TRUST_PROXY=$dayline_proxy_subnet|" "$dayline_release/.runtime.env"
# Validate syntax/key permissions before the previous application is stopped.
dayline_compose run --rm --no-deps gateway nginx -t > "$dayline_release/nginx-validation.log" 2>&1 || {
  echo 'Nginx configuration failed validation; inspect the private nginx-validation.log.' >&2; exit 1;
}
dayline_old_gateway=""
if [[ -f "$dayline_previous/.deploy.env" ]]; then
  dayline_old_gateway="$(dayline_old_compose ps -q gateway 2>/dev/null || true)"
fi
for dayline_port in "$DAYLINE_HTTP_PORT" "$DAYLINE_HTTPS_PORT"; do
  dayline_port_owned=false
  if [[ -n "$dayline_old_gateway" ]]; then
    if docker port "$dayline_old_gateway" | grep -Eq ":$dayline_port$"; then dayline_port_owned=true; fi
  fi
  if [[ "$dayline_port_owned" == false ]] && {
    [[ -n "$(ss -H -ltn "sport = :$dayline_port")" ]] ||
    [[ -n "$(docker ps -q --filter "publish=$dayline_port")" ]];
  }; then
    echo 'An Nginx entry port is already occupied. Existing services were not stopped.' >&2; exit 1;
  fi
done
while IFS='=' read -r dayline_key dayline_value; do export "$dayline_key=$dayline_value"; done < "$dayline_release/.database.env"
dayline_db_exec=(docker exec --env PGUSER --env PGDATABASE --env PGPASSWORD \
  --env DAYLINE_DATABASE_NAME --env DAYLINE_DATABASE_USER --env DAYLINE_DATABASE_PASSWORD)
"${dayline_db_exec[@]}" -i "$POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  < "$dayline_bundle/scripts/deploy/init-database.sql" > "$dayline_release/database-init.log" 2>&1 || {
    echo 'Database initialization failed; inspect the private database-init.log.' >&2; exit 1;
  }
docker run --rm --network "$DAYLINE_DB_NETWORK" --env-file "$dayline_release/.runtime.env" \
  "$DAYLINE_IMAGE" node scripts/deploy/check-database.mjs
# Do not touch an unrelated application already using this Compose project name.
dayline_existing_id="$(dayline_compose ps -aq app)"
if [[ -n "$dayline_existing_id" && ! -f "$dayline_previous/.deploy.env" ]]; then
  echo 'An application already uses this Compose project without a tracked release.' >&2; exit 1;
fi
if [[ -f "$dayline_previous/.deploy.env" ]]; then
  dayline_old_compose stop app
  dayline_stopped=true
fi
dayline_backup="$(mktemp "$dayline_root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$RELEASE_REVISION.XXXXXXXX.dump")"
"${dayline_db_exec[@]}" "$POSTGRES_CONTAINER" pg_dump -Fc -d "$POSTGRES_DB" > "$dayline_backup" 2> "$dayline_release/backup.log"
[[ -s "$dayline_backup" ]] || { echo 'Database backup is empty.' >&2; exit 1; }
chmod 600 "$dayline_backup"
dayline_migration_started=true
dayline_compose run --rm --no-deps app node apps/api/node_modules/prisma/build/index.js migrate deploy --config apps/api/prisma.config.ts > "$dayline_release/migration.log" 2>&1 || {
  echo 'Migration failed; inspect the private migration.log.' >&2; exit 1;
}
dayline_started=true
dayline_compose up -d --no-deps --wait --wait-timeout 180 app gateway
curl --fail --silent --show-error --connect-timeout 10 --max-time 20 \
  --dump-header "$dayline_release/public-health.headers" --output "$dayline_release/public-health.json" \
  "$SITE_URL/health/ready"
tr -d '\r' < "$dayline_release/public-health.headers" | grep -iqx "X-Dayline-Revision: $RELEASE_REVISION" || {
  echo 'The public HTTPS endpoint does not point to this release.' >&2; exit 1;
}
curl --fail --silent --show-error --connect-timeout 10 --max-time 20 \
  --output "$dayline_release/public-index.html" "$SITE_URL/day"
grep -q 'id="app"' "$dayline_release/public-index.html" || { echo 'The public website did not return the application.' >&2; exit 1; }
ln -sfn "$dayline_release" "$dayline_root/current.next"
mv -Tf "$dayline_root/current.next" "$dayline_root/current"
printf '%s\n' "$RELEASE_REVISION" > "$dayline_root/deployed-revision"
echo "Deployed revision $RELEASE_REVISION. Database and backups retained."
