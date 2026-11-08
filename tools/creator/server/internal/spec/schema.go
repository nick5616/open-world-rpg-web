// Package spec is the creator endpoint's WorldSpec gate: the contract schema
// (read from contracts/worldspec.schema.json at startup, never copied),
// structural validation, clamping and strict validation. It is a line-by-line
// port of tools/creator/web/src/spec/normalize.ts; both are tested against
// tools/creator/fixtures/normalize.json so a slider spec previewed in the
// browser is byte-for-byte the spec this endpoint mints.
package spec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// SchemaRel is the contract schema's path relative to the repo root.
var SchemaRel = filepath.Join("contracts", "worldspec.schema.json")

// FindRepoFile walks up from each start directory looking for rel and
// returns the first hit. The creator runs from the repo root (npm script),
// from its module directory (go test) or as a built binary under a temp dir
// (integration test), so a fixed relative path would break two of three.
func FindRepoFile(rel string, starts ...string) (string, error) {
	for _, start := range starts {
		dir, err := filepath.Abs(start)
		if err != nil {
			continue
		}
		for {
			p := filepath.Join(dir, rel)
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("%s not found above %v", rel, starts)
}

// Gate holds the compiled strict and relaxed schemas.
type Gate struct {
	raw     map[string]any // the contract schema, decoded (arrays keep order)
	strict  *jsonschema.Schema
	relaxed *jsonschema.Schema
	// SpecVersion is the only specVersion the schema allows (its minimum).
	SpecVersion int
}

// LoadGate reads and compiles the contract schema at path.
func LoadGate(path string) (*Gate, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return NewGate(b)
}

// NewGate compiles a schema document (the contract file's bytes).
func NewGate(schemaJSON []byte) (*Gate, error) {
	var raw map[string]any
	if err := json.Unmarshal(schemaJSON, &raw); err != nil {
		return nil, fmt.Errorf("worldspec schema: %w", err)
	}
	strictDoc := deepCopy(raw).(map[string]any)
	delete(strictDoc, "$id")
	relaxedDoc := Relax(raw)
	c := jsonschema.NewCompiler()
	if err := c.AddResource("worldspec.strict.json", toSchemaValue(strictDoc)); err != nil {
		return nil, err
	}
	if err := c.AddResource("worldspec.relaxed.json", toSchemaValue(relaxedDoc)); err != nil {
		return nil, err
	}
	strict, err := c.Compile("worldspec.strict.json")
	if err != nil {
		return nil, fmt.Errorf("compile strict schema: %w", err)
	}
	relaxed, err := c.Compile("worldspec.relaxed.json")
	if err != nil {
		return nil, fmt.Errorf("compile relaxed schema: %w", err)
	}
	sv, _ := prop(raw, "specVersion")["minimum"].(float64)
	return &Gate{raw: raw, strict: strict, relaxed: relaxed, SpecVersion: int(sv)}, nil
}

// Relax returns a copy of the contract schema without exactly the
// constraints the clamp repairs. Same rules as relaxSchema() in
// tools/creator/web/src/spec/schema.ts:
//  1. number/integer properties lose minimum/maximum (and the exclusive
//     forms); integers become numbers (the clamp rounds);
//  2. name loses minLength, maxLength, pattern (the clamp cleans it);
//  3. lootThemes loses maxItems, uniqueItems and its items' enum (the clamp
//     drops unknown, repeated and surplus tags);
//  4. $id is removed.
func Relax(schema map[string]any) map[string]any {
	s := deepCopy(schema).(map[string]any)
	delete(s, "$id")
	var relaxNumbers func(props map[string]any)
	relaxNumbers = func(props map[string]any) {
		for _, p := range props {
			o, ok := p.(map[string]any)
			if !ok {
				continue
			}
			switch o["type"] {
			case "number", "integer":
				for _, k := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"} {
					delete(o, k)
				}
				o["type"] = "number"
			case "object":
				if sub, ok := o["properties"].(map[string]any); ok {
					relaxNumbers(sub)
				}
			}
		}
	}
	props := s["properties"].(map[string]any)
	relaxNumbers(props)
	name := props["name"].(map[string]any)
	delete(name, "minLength")
	delete(name, "maxLength")
	delete(name, "pattern")
	loot := props["lootThemes"].(map[string]any)
	delete(loot, "maxItems")
	delete(loot, "uniqueItems")
	delete(loot["items"].(map[string]any), "enum")
	return s
}

// ModelSchema is the schema sent to the model for structured output: the
// contract schema minus the keywords the Messages API's JSON-schema output
// does not support (numeric ranges, string lengths, patterns, array size and
// uniqueness) and the $schema/$id/title annotations. Everything the API can
// enforce (types, required, additionalProperties: false, enums) stays; the
// rest is exactly what Normalize repairs or rejects afterwards.
func (g *Gate) ModelSchema() map[string]any {
	s := deepCopy(g.raw).(map[string]any)
	strip := []string{"$schema", "$id", "title", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "maxItems", "minItems", "uniqueItems"}
	// Walk schema nodes only (root, property schemas, items), so a property
	// that happened to be called "pattern" would never be deleted.
	var walk func(node map[string]any)
	walk = func(node map[string]any) {
		for _, k := range strip {
			delete(node, k)
		}
		if props, ok := node["properties"].(map[string]any); ok {
			for _, p := range props {
				if pm, ok := p.(map[string]any); ok {
					walk(pm)
				}
			}
		}
		if items, ok := node["items"].(map[string]any); ok {
			walk(items)
		}
	}
	walk(s)
	return s
}

func prop(schema map[string]any, key string) map[string]any {
	props, _ := schema["properties"].(map[string]any)
	p, _ := props[key].(map[string]any)
	return p
}

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(t))
		for k, c := range t {
			m[k] = deepCopy(c)
		}
		return m
	case []any:
		a := make([]any, len(t))
		for i, c := range t {
			a[i] = deepCopy(c)
		}
		return a
	default:
		return v
	}
}

// toSchemaValue re-decodes v the way the validator library expects
// (json.Number for numbers).
func toSchemaValue(v any) any {
	b, _ := json.Marshal(v)
	out, _ := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	return out
}

// validationErrors flattens a validator error into one line per leaf.
func validationErrors(err error) []string {
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return []string{err.Error()}
	}
	var out []string
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			loc := "/"
			if len(e.InstanceLocation) > 0 {
				loc = ""
				for _, p := range e.InstanceLocation {
					loc += "/" + p
				}
			}
			out = append(out, fmt.Sprintf("%s %s", loc, e.ErrorKind))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	return out
}
