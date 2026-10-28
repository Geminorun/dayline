import base64
from datetime import datetime, timezone
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


@unittest.skipUnless(all(shutil.which(command) for command in ('nginx', 'htpasswd', 'openssl')), 'Nginx HTTP checks require nginx, apache2-utils and openssl (enabled in the image CI job)')
class HttpsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temporary.name)
        cls.http_port, cls.https_port = free_port(), free_port()
        cls.password = 'fixture-password-with-no-real-credentials'
        cls.payload = (json.dumps({'kind': 'snapshot', 'collectionStatus': 'ok', 'generatedAt': datetime.now(timezone.utc).isoformat()}) + '\n').encode()
        (cls.directory / 'summary.ndjson').write_bytes(cls.payload)
        subprocess.run(['htpasswd', '-i', '-B', '-c', str(cls.directory / 'htpasswd'), 'dayline-diag'], input=cls.password + '\n', text=True, check=True, capture_output=True)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(cls.directory / 'tls.key'), '-out', str(cls.directory / 'tls.crt')], check=True, capture_output=True)
        snippet = Path(__file__).with_name('https.conf').read_text().replace('/etc/dayline-diagnostics/htpasswd', str(cls.directory / 'htpasswd')).replace('/var/lib/dayline-diagnostics/summary.ndjson', str(cls.directory / 'summary.ndjson'))
        (cls.directory / 'location.conf').write_text(snippet)
        # Fixtures may also run as root in a local test container; this is loopback only.
        worker = 'user root;' if os.getuid() == 0 else ''
        configuration = f'''
{worker}
daemon off;
pid {cls.directory}/nginx.pid;
error_log {cls.directory}/nginx-error.log;
events {{ worker_connections 32; }}
http {{
    access_log off;
    client_body_temp_path {cls.directory}/body;
    proxy_temp_path {cls.directory}/proxy;
    fastcgi_temp_path {cls.directory}/fastcgi;
    uwsgi_temp_path {cls.directory}/uwsgi;
    scgi_temp_path {cls.directory}/scgi;
    server {{ listen 127.0.0.1:{cls.http_port}; include {cls.directory}/location.conf; }}
    server {{
        listen 127.0.0.1:{cls.https_port} ssl;
        ssl_certificate {cls.directory}/tls.crt;
        ssl_certificate_key {cls.directory}/tls.key;
        include {cls.directory}/location.conf;
    }}
}}
'''
        (cls.directory / 'nginx.conf').write_text(configuration)
        cls.process = subprocess.Popen(['nginx', '-p', str(cls.directory), '-c', str(cls.directory / 'nginx.conf')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.cleanup)
        cls.context = ssl.create_default_context(cafile=str(cls.directory / 'tls.crt'))
        for _ in range(100):
            try:
                cls.request()
                return
            except OSError:
                if cls.process.poll() is not None:
                    raise RuntimeError((cls.directory / 'nginx-error.log').read_text())
                time.sleep(0.05)
        raise RuntimeError('Nginx fixture did not start')

    @classmethod
    def cleanup(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.temporary.cleanup()

    @classmethod
    def request(cls, password=None, method='GET', path='/internal/diagnostics', tls=True):
        connection = http.client.HTTPSConnection('localhost', cls.https_port, context=cls.context, timeout=2) if tls else http.client.HTTPConnection('localhost', cls.http_port, timeout=2)
        headers = {}
        if password is not None:
            headers['Authorization'] = 'Basic ' + base64.b64encode(('dayline-diag:' + password).encode()).decode()
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_authentication_is_required(self):
        for password in (None, 'wrong-password'):
            status, headers, body = self.request(password=password)
            self.assertEqual(status, 401)
            self.assertIn('WWW-Authenticate', headers)
            self.assertNotIn(b'collectionStatus', body)

    def test_correct_password_can_only_read_the_fixed_uncached_snapshot(self):
        status, headers, body = self.request(password=self.password)
        self.assertEqual(status, 200)
        self.assertEqual(body, self.payload)
        self.assertIn('no-store', headers['Cache-Control'])
        self.assertEqual(headers['Content-Type'], 'application/x-ndjson')
        self.assertEqual(json.loads(body)['collectionStatus'], 'ok')
        status, _, body = self.request(password=self.password, method='HEAD')
        self.assertEqual((status, body), (200, b''))
        for method in ('POST', 'PUT', 'DELETE'):
            status, _, body = self.request(password=self.password, method=method)
            self.assertIn(status, (403, 405))
            self.assertNotIn(b'collectionStatus', body)
        self.assertNotEqual(self.request(password=self.password, path='/internal/diagnostics/htpasswd')[0], 200)

    def test_plain_http_does_not_serve_a_snapshot(self):
        status, _, body = self.request(password=self.password, tls=False)
        self.assertEqual(status, 404)
        self.assertNotIn(b'collectionStatus', body)

    def test_workspace_client_fetches_with_a_secret_and_rejects_stale_data(self):
        environment = {
            'DAYLINE_DIAGNOSTICS_PASSWORD': self.password,
            'DAYLINE_DIAGNOSTICS_URL': f'https://localhost:{self.https_port}/internal/diagnostics',
            'SSL_CERT_FILE': str(self.directory / 'tls.crt'),
        }
        command = [sys.executable, str(Path(__file__).with_name('fetch.py'))]
        result = subprocess.run(command, env=environment, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, self.payload)
        self.assertNotIn(self.password.encode(), result.stdout + result.stderr)
        try:
            (self.directory / 'summary.ndjson').write_bytes(b'{"kind":"snapshot","collectionStatus":"ok","generatedAt":"2000-01-01T00:00:00Z"}\n')
            result = subprocess.run(command, env=environment, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.assertIn(b'stale', result.stderr)
        finally:
            (self.directory / 'summary.ndjson').write_bytes(self.payload)
