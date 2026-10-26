import { z } from 'zod';
export const guestManifestSchema = z
  .object({
    schema: z.literal(1),
    datasetId: z.uuid(),
    revision: z.number().int().positive(),
    generation: z.string().regex(/^[a-zA-Z0-9-]+$/),
    length: z.number().int().positive(),
    chunks: z.number().int().min(1).max(200),
    checksum: z.string(),
  })
  .strict();
