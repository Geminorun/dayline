#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
[[ $# -eq 0 ]] || { echo 'Arguments are not supported.' >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo 'Run through the dedicated sudo rule.' >&2; exit 77; }
readonly app=dayline-app-1
readonly -a docker=(/usr/bin/docker --host=unix:///var/run/docker.sock)
readonly filter=/usr/local/libexec/dayline-diagnostics/filter.py
printf '{"kind":"diagnostics","version":1,"window":"15m","maxRawLines":1000}\n'
if ! "${docker[@]}" inspect "$app" --format '{"kind":"container","state":"{{.State.Status}}","health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}"}' 2>/dev/null; then
  printf '{"kind":"container","available":false}\n'
  exit 0
fi
if ! timeout 10s "${docker[@]}" exec "$app" node -e '
const crypto = require("node:crypto");
const sender = process.env.MAIL_FROM || "";
const address = sender.includes("<") ? /^[^<>\r\n]+ <([^<>\r\n]+)>$/.exec(sender)?.[1] || "" : sender;
const valid = /^[^\s<>@]+@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)$/.exec(address);
const key = process.env.RESEND_API_KEY || "";
const revision = process.env.RELEASE_REVISION || "";
console.log(JSON.stringify({kind:"runtime",revision:/^[a-f0-9]{40}$/.test(revision)?revision:"unknown",mailTransport:["file","resend"].includes(process.env.MAIL_TRANSPORT)?process.env.MAIL_TRANSPORT:"unknown",mailFromValid:!!valid,mailFromDomain:valid?valid[1]:null,resendKeyConfigured:!!key,resendKeyFingerprint:key?crypto.createHash("sha256").update(key).digest("hex").slice(0,12):null}));
' 2>/dev/null; then
  printf '{"kind":"runtime","available":false}\n'
fi
timeout 15s "${docker[@]}" logs --timestamps --since 15m --tail 1000 "$app" 2>&1 | /usr/bin/python3 "$filter"
