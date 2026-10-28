#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
[[ $EUID -eq 0 && $# -eq 0 ]] || { echo 'Usage: sudo bash install-https.sh' >&2; exit 64; }
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly lib=/usr/local/libexec/dayline-diagnostics
readonly auth=/etc/dayline-diagnostics
readonly state=/var/lib/dayline-diagnostics
command -v htpasswd >/dev/null || { echo 'Install the password utility first: sudo apt-get install -y apache2-utils' >&2; exit 69; }
for command in nginx python3 docker systemctl getent install; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command." >&2; exit 69; }
done
getent group www-data >/dev/null
for path in "$lib" "$lib/filter.py" "$auth" "$auth/htpasswd" "$state" "$state/summary.ndjson" /usr/local/sbin/dayline-diagnostics /usr/local/sbin/dayline-diagnostics-snapshot /etc/nginx/snippets/dayline-diagnostics.conf /etc/systemd/system/dayline-diagnostics.service /etc/systemd/system/dayline-diagnostics.timer; do
  [[ ! -L "$path" ]] || { echo 'Refusing to install over a symbolic link.' >&2; exit 65; }
done
install -d -o root -g root -m 755 "$lib" /etc/nginx/snippets
install -d -o root -g www-data -m 750 "$auth" "$state"
readonly password_file="$(mktemp "$auth/.htpasswd.XXXXXXXX")"
trap 'rm -f "$password_file"' EXIT
if [[ ! -f "$auth/htpasswd" ]]; then
  IFS= read -r -s -p 'Diagnostic password (24-72 ASCII characters): ' diagnostic_password < /dev/tty
  printf '\n' > /dev/tty
  IFS= read -r -s -p 'Confirm diagnostic password: ' diagnostic_confirmation < /dev/tty
  printf '\n' > /dev/tty
  [[ "$diagnostic_password" == "$diagnostic_confirmation" ]] || { echo 'Passwords do not match.' >&2; exit 65; }
  printf '%s' "$diagnostic_password" | python3 -c 'import sys; value=sys.stdin.buffer.read(); sys.exit(0 if 24 <= len(value) <= 72 and all(32 <= byte <= 126 for byte in value) else 1)' || { echo 'Use 24-72 ASCII characters.' >&2; exit 65; }
  printf '%s\n' "$diagnostic_password" | htpasswd -i -B -c "$password_file" dayline-diag
  unset diagnostic_password diagnostic_confirmation
  install -o root -g www-data -m 640 "$password_file" "$auth/htpasswd"
else
  chown root:www-data "$auth/htpasswd"
  chmod 640 "$auth/htpasswd"
fi
install -o root -g root -m 755 "$source_dir/read.sh" /usr/local/sbin/dayline-diagnostics
install -o root -g root -m 755 "$source_dir/filter.py" "$lib/filter.py"
install -o root -g root -m 755 "$source_dir/snapshot.py" /usr/local/sbin/dayline-diagnostics-snapshot
install -o root -g root -m 644 "$source_dir/https.conf" /etc/nginx/snippets/dayline-diagnostics.conf
install -o root -g root -m 644 "$source_dir/dayline-diagnostics.service" /etc/systemd/system/dayline-diagnostics.service
install -o root -g root -m 644 "$source_dir/dayline-diagnostics.timer" /etc/systemd/system/dayline-diagnostics.timer
systemctl daemon-reload
systemctl start dayline-diagnostics.service
systemctl enable --now dayline-diagnostics.timer
cat <<'INSTRUCTIONS'
HTTPS snapshot collection installed. Username: dayline-diag
Add this line inside the existing Dayline server block with `listen 443 ssl`:
    include /etc/nginx/snippets/dayline-diagnostics.conf;
Then run:
    sudo nginx -t && sudo systemctl reload nginx
Nginx has not been reloaded or its existing site configuration edited.
INSTRUCTIONS
