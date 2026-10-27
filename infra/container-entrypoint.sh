#!/bin/sh
set -eu
# Preserve inherited outbound proxies/CA settings and bypass them only for this
# application's internal services and loopback health checks.
dayline_no_proxy="${NO_PROXY:-},${no_proxy:-},api,db,dayline-postgres,localhost,127.0.0.1,::1"
export NO_PROXY="$dayline_no_proxy"
export no_proxy="$dayline_no_proxy"
exec "$@"
