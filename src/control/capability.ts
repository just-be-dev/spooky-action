// A capability is one entry in a control surface's command vocabulary:
// the wire discriminator it answers to, the payload schema, and how to
// execute it. Surfaces declare what they can do as data, so the bridge
// can dispatch against whatever surface is provided — the overlay does
// rings and clicks; a webpage surface might do scroll and highlight.
import { Effect, JsonSchema, Schema } from "effect";

export interface Capability {
  /** Wire discriminator this capability answers to (`{"type": …}`). */
  readonly type: string;
  /** JSON Schema for the command payload — advertised to clients on connect. */
  readonly schema: JsonSchema.JsonSchema;
  /** Validate a raw payload against the capability's schema and execute it. */
  readonly handle: (payload: unknown) => Effect.Effect<void, Schema.SchemaError>;
}

/** The decoded command a capability handler receives: tag + payload fields. */
type Command<T extends string, Fields extends Schema.Struct.Fields> = {
  readonly [K in keyof Fields]: Schema.Schema.Type<Fields[K]>;
} & { readonly type: T };

/**
 * Build a capability from its wire discriminator, payload fields, and
 * handler. The schema/handler types are tied together here so the surface
 * gets full inference; consumers only ever see the erased `Capability`.
 */
export const capability = <const T extends string, Fields extends Schema.Struct.Fields>(
  type: T,
  fields: Fields,
  execute: (command: Command<T, Fields>) => Effect.Effect<void>,
): Capability => {
  const schema = Schema.Struct({ type: Schema.Literal(type), ...fields });
  const decode = Schema.decodeUnknownEffect(schema);
  return {
    type,
    schema: Schema.toJsonSchemaDocument(schema).schema,
    handle: (payload) =>
      decode(payload).pipe(
        // The struct's mapped Type doesn't unify with Command<T, Fields>
        // inside a generic body (higher-order mapped types), but they are
        // the same shape — assert once here.
        Effect.flatMap((command) => execute(command as Command<T, Fields>)),
      ) as Effect.Effect<void, Schema.SchemaError>,
  };
};
