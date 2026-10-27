#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
dayline_bundle="${1:?Expected deployment bundle}"
dayline_image="$(cat "$dayline_bundle/image.ref")"
[[ "$dayline_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Expected an immutable GHCR image digest.' >&2; exit 1;
}
command -v docker >/dev/null
dayline_registry_config="$(mktemp -d)"
trap 'rm -rf -- "$dayline_registry_config"; rm -f -- "$dayline_bundle/registry.token"' EXIT
docker --config "$dayline_registry_config" login ghcr.io \
  --username "$(cat "$dayline_bundle/registry.user")" --password-stdin \
  < "$dayline_bundle/registry.token" >/dev/null
docker --config "$dayline_registry_config" pull "$dayline_image"
rm -f -- "$dayline_bundle/registry.token"
docker --config "$dayline_registry_config" logout ghcr.io >/dev/null
bash "$dayline_bundle/scripts/deploy/apply.sh" "$dayline_bundle"
