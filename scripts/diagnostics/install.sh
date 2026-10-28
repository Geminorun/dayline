#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 && $# -eq 1 ]] || { echo 'Usage: sudo bash install.sh /path/to/reader.pub' >&2; exit 64; }
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly account=dayline-log-reader
readonly reader_home=/var/lib/dayline-log-reader
readonly destination=/usr/local/libexec/dayline-diagnostics
for command in docker python3 ssh-keygen visudo useradd install getent; do command -v "$command" >/dev/null; done
ssh-keygen -lf "$1" >/dev/null
read -r key_type key_data _ < "$1"
[[ "$key_type" == ssh-ed25519 && "$key_data" =~ ^[a-zA-Z0-9+/=]+$ ]] || { echo 'Expected one Ed25519 public key.' >&2; exit 65; }
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --home-dir "$reader_home" --shell /bin/sh "$account"
fi
IFS=: read -r _ _ reader_uid _ _ actual_home _ <<< "$(getent passwd "$account")"
[[ "$reader_uid" != 0 && "$actual_home" == "$reader_home" ]] || { echo 'Reader account has an unexpected UID or home directory.' >&2; exit 65; }
# This account must never obtain arbitrary Docker access or a general sudo role.
[[ " $(id -nG "$account") " != *' docker '* && " $(id -nG "$account") " != *' sudo '* ]] || { echo 'Reader account has unexpected privileged groups.' >&2; exit 65; }
for path in "$reader_home" "$reader_home/.ssh" "$reader_home/.ssh/authorized_keys" "$destination" "$destination/filter.py" /usr/local/sbin/dayline-diagnostics /etc/sudoers.d/dayline-diagnostics; do
  [[ ! -L "$path" ]] || { echo 'Refusing to install over a symbolic link.' >&2; exit 65; }
done
install -d -o root -g root -m 755 "$reader_home" "$reader_home/.ssh" "$destination"
install -o root -g root -m 755 "$source_dir/filter.py" "$destination/filter.py"
install -o root -g root -m 755 "$source_dir/read.sh" /usr/local/sbin/dayline-diagnostics
readonly rule="$(mktemp)"
readonly authorized_key="$(mktemp)"
trap 'rm -f "$rule" "$authorized_key"' EXIT
printf 'restrict,command="/usr/bin/sudo -n /usr/local/sbin/dayline-diagnostics" %s %s dayline-diagnostics\n' "$key_type" "$key_data" > "$authorized_key"
install -o root -g root -m 644 "$authorized_key" "$reader_home/.ssh/authorized_keys"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/dayline-diagnostics ""\n' "$account" > "$rule"
visudo -cf "$rule"
install -o root -g root -m 440 "$rule" /etc/sudoers.d/dayline-diagnostics
echo 'Read-only diagnostic key installed; no shell, forwarding or Docker group access.'
