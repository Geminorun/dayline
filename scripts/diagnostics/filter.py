#!/usr/bin/env python3
"""Project an application log stream onto a bounded, non-private support schema."""
import json
import re
import sys

HEADER = re.compile(r'^(?:\d{4}-\d\d-\d\dT\S+Z )?(\d{4}-\d\d-\d\dT[\d:.]+Z) (INFO|WARN|ERROR|FATAL) \d+ \[([\w.]+)\] (?:requestId=([\w-]+) )?(.*)$')
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$', re.I)
ROUTES = {'/health/live', '/health/ready', '/api/v1/auth/session', '/api/v1/me', '/api/auth/:operation'} | {
    '/api/auth/' + path for path in ('sign-up/email', 'sign-in/email', 'send-verification-email', 'verify-email', 'request-password-reset', 'reset-password', 'change-password', 'get-session', 'sign-out')
}
ENUMS = {
    'method': {'GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'},
    'mailStatus': {'accepted', 'failed', 'unconfirmed', 'not_sent'},
    'accountStatus': {'created', 'pending_verification', 'registered', 'unknown'},
    'nextStep': {'verify_email', 'login'},
    'purpose': {'email_verification', 'email_binding', 'password_reset'},
    'provider': {'resend'},
    'providerCode': {'validation_error', 'missing_api_key', 'invalid_api_key', 'restricted_api_key', 'rate_limit_exceeded', 'daily_quota_exceeded', 'monthly_quota_exceeded', 'application_error', 'internal_server_error', 'invalid_access', 'not_found', 'provider_rejected', 'timeout', 'network_error', 'invalid_response'},
}


def public_event(line):
    match = HEADER.match(line.rstrip('\n'))
    if not match:
        return None
    timestamp, level, module, request_id, body = match.groups()
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    event = {'timestamp': timestamp, 'level': level, 'module': module}
    for name, values in ENUMS.items():
        if isinstance(data.get(name), str) and data[name] in values:
            event[name] = data[name]
    for name in ('code', 'errorCode'):
        value = data.get(name)
        if isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', value):
            event[name] = value
    error_type = data.get('errorType')
    if isinstance(error_type, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9.]{0,79}', error_type):
        event['errorType'] = error_type
    for name in ('status', 'providerStatus', 'durationMs', 'retryAfterSeconds', 'dueUsers', 'dueTrash', 'failures'):
        value = data.get(name)
        if type(value) is int and 0 <= value <= 1_000_000_000:
            event[name] = value
    for name in ('requestId', 'messageId'):
        value = data.get(name, request_id if name == 'requestId' else None)
        if isinstance(value, str) and UUID.fullmatch(value):
            event[name] = value
    route = data.get('route')
    if isinstance(route, str) and route in ROUTES:
        event['route'] = route
    operation = data.get('operation')
    if isinstance(operation, str) and '/api/auth' + operation in ROUTES:
        event['operation'] = operation
    return event if 'code' in event else None


def filter_lines(lines):
    current = None
    frames = []
    for line in lines:
        if len(line) > 16384:
            continue
        event = public_event(line)
        if event:
            if current:
                if frames:
                    current['frames'] = frames
                yield current
            current, frames = event, []
        elif current and current['level'] in ('ERROR', 'FATAL') and len(frames) < 8:
            # Only V8 code locations under the application directory, without error text.
            frame = re.search(r'\bat ([\w.$<> ]+ )?\(?(/app/[\w./@+-]+):(\d+):(\d+)\)?$', line.strip())
            if frame:
                location = '/'.join(frame[2].split('/')[-2:])
                frames.append(f'at {(frame[1] or "").strip()} ({location}:{frame[3]}:{frame[4]})')
    if current:
        if frames:
            current['frames'] = frames
        yield current


if __name__ == '__main__':
    for event in filter_lines(sys.stdin):
        print(json.dumps(event, separators=(',', ':')))
