// The WorldSpec schema straight from contracts/ (never a local copy), plus
// the "relaxed" variant the normalizer validates against first.
//
// Why two schemas: spec 6 says a model-made (or slider-made) spec is
// validated and rejected on any failure, *and* that every number is clamped
// and unknown tags dropped. Both can only be true if validation is
// structural (shape, types, required keys, no extra keys, enum fields that
// cannot be clamped) and the range/tag rules are enforced by clamping. So the
// relaxed schema is the contract schema minus exactly the constraints the
// clamp repairs; after clamping, the result must pass the strict schema too.
// tools/creator/server/internal/spec/schema.go derives the same relaxed
// schema with the same rules; the shared fixtures prove the two agree.
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import contractSchema from '../../../../../contracts/worldspec.schema.json';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

/** The contract schema as published in contracts/worldspec.schema.json. */
export const STRICT_SCHEMA = contractSchema as unknown as JsonObject;

const RANGE_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];

/**
 * Relax a copy of the contract schema (rules shared with the Go endpoint):
 *  1. every number/integer property loses its range keywords and integers
 *     become numbers (the clamp rounds them);
 *  2. `name` loses minLength, maxLength and pattern (the clamp cleans it);
 *  3. `lootThemes` loses maxItems, uniqueItems and its items' enum (the clamp
 *     drops unknown, repeated and surplus tags);
 *  4. `$id` is removed so both schemas can live in one validator.
 * Everything else (required, additionalProperties: false, types, the palette
 * and nameGrammar enums, the seed pattern) stays.
 */
export function relaxSchema(schema: JsonObject): JsonObject {
  const s = structuredClone(schema);
  delete s.$id;
  const relaxNumbers = (props: JsonObject) => {
    for (const p of Object.values(props)) {
      const o = p as JsonObject;
      if (o.type === 'number' || o.type === 'integer') {
        for (const k of RANGE_KEYS) delete o[k];
        o.type = 'number';
      } else if (o.type === 'object' && o.properties) {
        relaxNumbers(o.properties as JsonObject);
      }
    }
  };
  const props = s.properties as JsonObject;
  relaxNumbers(props);
  const name = props.name as JsonObject;
  delete name.minLength;
  delete name.maxLength;
  delete name.pattern;
  const loot = props.lootThemes as JsonObject;
  delete loot.maxItems;
  delete loot.uniqueItems;
  delete (loot.items as JsonObject).enum;
  return s;
}

const strictCopy = structuredClone(STRICT_SCHEMA);
delete strictCopy.$id;
export const RELAXED_SCHEMA = relaxSchema(STRICT_SCHEMA);

// allErrors so the UI can list every problem at once; strict: false because
// the contract uses "description" on nested nodes, which is fine but ajv's
// strict mode also rejects some 2020-12 annotations we don't control.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const strictValidate: ValidateFunction = ajv.compile(strictCopy);
const relaxedValidate: ValidateFunction = ajv.compile(RELAXED_SCHEMA);

function fmt(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`);
}

/** Validate against the contract schema exactly. Returns error strings (empty = valid). */
export function validateStrict(value: unknown): string[] {
  return strictValidate(value) ? [] : fmt(strictValidate.errors);
}

/** Validate against the relaxed (structural) schema. */
export function validateRelaxed(value: unknown): string[] {
  return relaxedValidate(value) ? [] : fmt(relaxedValidate.errors);
}
