package spec

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"slices"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"lodestone/server/pkg/worldspec"
)

// Change is one repair the clamp made (same shape as the TS Change).
type Change struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	From   any    `json:"from"`
	To     any    `json:"to"`
}

// Result is a normalized spec: the struct, its canonical JSON and the repairs.
type Result struct {
	Spec    worldspec.WorldSpec
	JSON    []byte
	Changes []Change
}

// RejectedError lists why a spec was refused (structure, name, seed, or the
// final strict check).
type RejectedError struct{ Errors []string }

func (e *RejectedError) Error() string { return "worldspec rejected: " + strings.Join(e.Errors, "; ") }

// NameBlocklist is worldgen/src/names.rs BLOCKLIST, matched per word prefix
// (see NAME_BLOCKLIST in normalize.ts for why).
var NameBlocklist = []string{
	"hyrul", "zelda", "ganon", "hylia", "kakarik", "gerudo", "goron", "zora", "rito", "korok", "sheikah", "epona",
	"creeper", "ender", "nether", "herobrine", "steve", "valheim", "midgard", "asgard", "yggdras", "odin",
	"nazi", "fuck", "shit", "cunt", "rape", "slut", "piss",
}

var uint64Max = new(big.Int).SetUint64(math.MaxUint64)

// roundHalfUp is floor(x + 0.5), as in the TS port (math.Round rounds
// negative halves away from zero, JS Math.round toward +inf).
func roundHalfUp(x float64) float64 { return math.Floor(x + 0.5) }

func clampF(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

func nameRuneOK(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '\'' || r == ' ' || r == '-'
}

// CleanName maps disallowed characters to spaces, collapses and trims spaces
// and cuts to maxLen (the result may be too short; Normalize rejects that).
func CleanName(name string, maxLen int) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range name {
		if !nameRuneOK(r) {
			r = ' '
		}
		if r == ' ' {
			if prevSpace {
				continue
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
		b.WriteRune(r)
	}
	s := strings.Trim(b.String(), " ")
	if len(s) > maxLen { // ASCII only by now, so bytes == characters
		s = strings.TrimRight(s[:maxLen], " ")
	}
	return s
}

// BlockedStem returns the blocked stem some word of name starts with, or "".
func BlockedStem(name string) string {
	words := strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return r == ' ' || r == '\'' || r == '-' })
	for _, w := range words {
		for _, b := range NameBlocklist {
			if strings.HasPrefix(w, b) {
				return b
			}
		}
	}
	return ""
}

// Normalize validates (structurally), clamps and strictly validates an
// untrusted WorldSpec JSON document. See normalize.ts for the rules; the
// order of fields is the schema's top-level `required` array.
func (g *Gate) Normalize(input []byte) (Result, error) {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(input))
	if err != nil {
		return Result{}, &RejectedError{[]string{"not JSON: " + err.Error()}}
	}
	if err := g.relaxed.Validate(inst); err != nil {
		return Result{}, &RejectedError{validationErrors(err)}
	}
	v, err := numbersToFloat(inst)
	if err != nil {
		return Result{}, &RejectedError{[]string{err.Error()}}
	}
	spec := v.(map[string]any)
	var changes []Change
	var errs []string
	note := func(path, reason string, from, to any) {
		changes = append(changes, Change{Path: path, Reason: reason, From: from, To: to})
	}
	clampNumber := func(path string, x float64, schema map[string]any) float64 {
		lo, _ := schema["minimum"].(float64)
		hi, _ := schema["maximum"].(float64)
		// "+ 0" turns -0 into 0 so Go never writes "-0" where JS writes "0".
		out := clampF(x, lo, hi) + 0
		if out != x {
			note(path, "clamped", x, out)
		}
		if schema["type"] == "integer" {
			r := roundHalfUp(out)
			if r != out {
				note(path, "rounded", out, r)
			}
			out = r
		}
		return out
	}

	for _, keyAny := range g.raw["required"].([]any) {
		key := keyAny.(string)
		schema := prop(g.raw, key)
		switch {
		case schema["type"] == "number" || schema["type"] == "integer":
			spec[key] = clampNumber(key, spec[key].(float64), schema)
		case schema["type"] == "object":
			group := spec[key].(map[string]any)
			sub := schema["properties"].(map[string]any)
			var keys []string
			for _, k := range schema["required"].([]any) {
				keys = append(keys, k.(string))
			}
			for _, k := range keys {
				group[k] = clampNumber(key+"."+k, group[k].(float64), sub[k].(map[string]any))
			}
			maxW := 0.0
			for _, k := range keys {
				if w := group[k].(float64); w > maxW {
					maxW = w
				}
			}
			if maxW != 1 {
				for _, k := range keys {
					cur := group[k].(float64)
					next := 1.0
					if maxW != 0 {
						next = cur / maxW
					}
					if next != cur {
						note(key+"."+k, "renormalized", cur, next)
					}
					group[k] = next
				}
			}
		case key == "name":
			orig := spec[key].(string)
			maxLen, _ := schema["maxLength"].(float64)
			minLen, _ := schema["minLength"].(float64)
			cleaned := CleanName(orig, int(maxLen))
			if cleaned != orig {
				note(key, "name-cleaned", orig, cleaned)
			}
			spec[key] = cleaned
			if len(cleaned) < int(minLen) {
				errs = append(errs, fmt.Sprintf("/name has fewer than %d usable characters", int(minLen)))
			}
			if stem := BlockedStem(cleaned); stem != "" {
				errs = append(errs, fmt.Sprintf("/name contains a blocked word (%q...)", stem))
			}
		case key == "seed":
			orig := spec[key].(string)
			n, ok := new(big.Int).SetString(orig, 10)
			if !ok {
				errs = append(errs, "/seed is not a decimal integer")
				break
			}
			if n.Cmp(uint64Max) > 0 {
				errs = append(errs, "/seed is larger than 2^64-1")
			}
			canon := n.String()
			if canon != orig {
				note(key, "seed-canonical", orig, canon)
			}
			spec[key] = canon
		case key == "lootThemes":
			items := schema["items"].(map[string]any)
			var vocab []string
			for _, e := range items["enum"].([]any) {
				vocab = append(vocab, e.(string))
			}
			maxItems, _ := schema["maxItems"].(float64)
			out := []any{}
			var kept []string
			for _, t := range spec[key].([]any) {
				tag := t.(string)
				switch {
				case !slices.Contains(vocab, tag):
					note(key, "dropped-unknown-tag", tag, nil)
				case slices.Contains(kept, tag):
					note(key, "dropped-duplicate", tag, nil)
				case len(kept) >= int(maxItems):
					note(key, "dropped-over-limit", tag, nil)
				default:
					kept = append(kept, tag)
					out = append(out, tag)
				}
			}
			spec[key] = out
		}
		// palette / nameGrammar: enum already enforced by the relaxed schema.
	}
	if len(errs) > 0 {
		return Result{}, &RejectedError{errs}
	}
	b, err := json.Marshal(spec)
	if err != nil {
		return Result{}, err
	}
	strictInst, _ := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	if err := g.strict.Validate(strictInst); err != nil {
		return Result{}, &RejectedError{validationErrors(err)}
	}
	var ws worldspec.WorldSpec
	if err := json.Unmarshal(b, &ws); err != nil {
		return Result{}, &RejectedError{[]string{err.Error()}}
	}
	out, err := json.Marshal(ws)
	if err != nil {
		return Result{}, err
	}
	if changes == nil {
		changes = []Change{}
	}
	return Result{Spec: ws, JSON: out, Changes: changes}, nil
}

// ValidateStrict checks a spec against the contract schema exactly
// (used on spec_from_seed output before minting it untouched).
func (g *Gate) ValidateStrict(specJSON []byte) error {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(specJSON))
	if err != nil {
		return &RejectedError{[]string{"not JSON: " + err.Error()}}
	}
	if err := g.strict.Validate(inst); err != nil {
		return &RejectedError{validationErrors(err)}
	}
	return nil
}

// numbersToFloat converts the validator's json.Number values to float64
// (what JS sees after JSON.parse). Non-finite results are rejected.
func numbersToFloat(v any) (any, error) {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return nil, fmt.Errorf("number %s is out of range", t)
		}
		return f, nil
	case map[string]any:
		for k, c := range t {
			n, err := numbersToFloat(c)
			if err != nil {
				return nil, err
			}
			t[k] = n
		}
		return t, nil
	case []any:
		for i, c := range t {
			n, err := numbersToFloat(c)
			if err != nil {
				return nil, err
			}
			t[i] = n
		}
		return t, nil
	default:
		return v, nil
	}
}
