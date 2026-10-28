#!/usr/bin/env python3
"""Fetch a fresh HTTPS diagnostic snapshot using a workspace secret."""
import base64
from datetime import datetime, timezone
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    password = os.environ.get('DAYLINE_DIAGNOSTICS_PASSWORD')
    if not password:
        print('Missing workspace Secret: DAYLINE_DIAGNOSTICS_PASSWORD.', file=sys.stderr)
        return 1
    url = os.environ.get('DAYLINE_DIAGNOSTICS_URL', 'https://dayline.mindreview.me/internal/diagnostics')
    try:
        parsed = urllib.parse.urlsplit(url)
        valid_url = parsed.scheme == 'https' and parsed.netloc and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path == '/internal/diagnostics'
    except ValueError:
        valid_url = False
    if not valid_url:
        print('Expected an HTTPS diagnostic URL without credentials or query parameters.', file=sys.stderr)
        return 1
    credentials = base64.b64encode(('dayline-diag:' + password).encode()).decode()
    request = urllib.request.Request(url, headers={'Authorization': 'Basic ' + credentials})
    try:
        # Retain the environment's normal HTTP proxy/CA handling; do not forward credentials through redirects.
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024 or response.headers.get_content_type() != 'application/x-ndjson':
                raise ValueError('Invalid snapshot response')
        records = [json.loads(line) for line in body.splitlines()]
        metadata = records[0]
        if not isinstance(metadata, dict) or metadata.get('kind') != 'snapshot' or metadata.get('collectionStatus') != 'ok':
            raise ValueError('Snapshot collection failed')
        timestamp = metadata.get('generatedAt')
        if not isinstance(timestamp, str):
            raise ValueError('Missing snapshot timestamp')
        generated = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        age = (datetime.now(timezone.utc) - generated).total_seconds()
        if not -30 <= age <= 180:
            print('Snapshot is stale or server time differs; inspect dayline-diagnostics.timer.', file=sys.stderr)
            return 1
    except urllib.error.HTTPError as error:
        print(f'Diagnostic endpoint returned HTTP {error.code}; check authentication and the Nginx include.', file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print('Unable to read a valid diagnostic snapshot; check connectivity and the collection service.', file=sys.stderr)
        return 1
    sys.stdout.buffer.write(body)
    return 0


if __name__ == '__main__':
    sys.exit(main())
