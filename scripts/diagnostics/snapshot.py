#!/usr/bin/python3
"""Atomically publish the existing collector's bounded, sanitized output."""
from datetime import datetime, timezone
import grp
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def build_snapshot(collector='/usr/local/sbin/dayline-diagnostics'):
    metadata = {'kind': 'snapshot', 'collectionStatus': 'failed'}
    body = b''
    try:
        result = subprocess.run([collector], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=35)
        if len(result.stdout) > 4 * 1024 * 1024:
            raise ValueError('Snapshot exceeds the size bound')
        records = [json.loads(line) for line in result.stdout.splitlines()]
        if not records or not all(isinstance(row, dict) for row in records) or records[0].get('kind') != 'diagnostics':
            raise ValueError('Invalid collector response')
        body = result.stdout.rstrip(b'\n') + b'\n'
        metadata['collectionStatus'] = 'ok'
    except (OSError, ValueError, subprocess.SubprocessError):
        # Never publish partial output or exception text, which can contain private data.
        pass
    metadata['generatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    return json.dumps(metadata, separators=(',', ':')).encode() + b'\n' + body


def publish_snapshot(directory, payload, web_gid):
    directory = Path(directory)
    descriptor, temporary = tempfile.mkstemp(prefix='.summary.', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchown(output.fileno(), -1, web_gid)
            os.fchmod(output.fileno(), 0o640)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, directory / 'summary.ndjson')
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        return 64
    payload = build_snapshot()
    publish_snapshot('/var/lib/dayline-diagnostics', payload, grp.getgrnam('www-data').gr_gid)
    return 0 if json.loads(payload.splitlines()[0])['collectionStatus'] == 'ok' else 1


if __name__ == '__main__':
    sys.exit(main())
