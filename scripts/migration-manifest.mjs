import { readdir } from 'node:fs/promises';
/** The committed migration directories are the expected deploy/restore schema. */
export async function repositoryMigrations() {
  const entries = await readdir(
    new URL('../apps/api/prisma/migrations/', import.meta.url),
    { withFileTypes: true },
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
