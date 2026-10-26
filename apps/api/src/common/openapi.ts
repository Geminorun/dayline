import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

export function dtoSchema(schema: z.ZodType): SchemaObject {
  // Zod's declared result also covers JSON Schema targets; this target is OpenAPI 3.0.
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as SchemaObject;
}
export function dataResponseSchema(schema: z.ZodType): SchemaObject {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: dtoSchema(schema),
      meta: {
        type: 'object',
        required: ['requestId', 'serverTime'],
        properties: {
          requestId: { type: 'string' },
          serverTime: { type: 'string', format: 'date-time' },
        },
      },
    },
  };
}
