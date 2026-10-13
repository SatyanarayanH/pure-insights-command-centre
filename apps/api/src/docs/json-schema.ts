import { z } from 'zod';

export type Json = Record<string, unknown>;

/**
 * zod -> JSON Schema for a specification document.
 *
 * Schemas named with `.meta({ id })` come back under `$defs`; they are hoisted into the shared
 * `components` map and referenced from there, so `Alert` is defined once however many
 * operations and messages use it.
 */
export function jsonSchemaOf(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, unknown>,
): Json {
  const generated = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: ({ jsonSchema }) => {
      // zod states the safe-integer range on every integer; it is noise in a spec.
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
    },
  });
  const json = JSON.parse(
    JSON.stringify(generated).replaceAll('#/$defs/', '#/components/schemas/'),
  ) as Json & {
    $defs?: Record<string, unknown>;
  };
  for (const [name, definition] of Object.entries(json.$defs ?? {}))
    components[name] ??= definition;
  delete json.$defs;
  delete json.$schema;
  return json;
}

export const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
