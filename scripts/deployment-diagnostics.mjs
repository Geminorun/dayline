// Smoke tests use generated credentials, never production configuration.
// Keep diagnostics useful without publishing their temporary credentials.
export function redactDiagnostics(text, privateValues) {
  const values = [...new Set(privateValues.filter(Boolean))]
    .flatMap((value) => [value, encodeURIComponent(value)])
    .sort((a, b) => b.length - a.length);
  let result = text.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    '[redacted PEM]',
  );
  for (const value of values) result = result.replaceAll(value, '[redacted]');
  return result;
}
