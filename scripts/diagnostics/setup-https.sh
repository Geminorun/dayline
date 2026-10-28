#!/bin/bash
# Download one reviewed commit without requiring a server-side Git checkout.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: bash setup-https.sh COMMIT_SHA' >&2; exit 64; }
readonly revision="$1"
readonly dayline_setup="$(mktemp -d)"
trap 'rm -rf -- "$dayline_setup"' EXIT
for file in read.sh filter.py snapshot.py https.conf dayline-diagnostics.service dayline-diagnostics.timer install-https.sh; do
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/Geminorun/dayline/$revision/scripts/diagnostics/$file" \
    --output "$dayline_setup/$file"
done
sudo bash "$dayline_setup/install-https.sh"
