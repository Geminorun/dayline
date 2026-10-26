import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

export function dtoSchema(schema: z.ZodType): SchemaObject {
  // Zod's declared result also covers JSON Schema targets; this target is OpenAPI 3.0.
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  }) as SchemaObject;
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
          dataVersion: {
            type: 'string',
            pattern: '^[1-9][0-9]*$',
            description: '本次业务写事务提交后的用户数据版本（十进制 bigint）',
          },
        },
      },
    },
  };
}
