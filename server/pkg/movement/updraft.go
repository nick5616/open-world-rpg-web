package movement

import (
	"strconv"
	"strings"
)

// Column is one debug updraft column: a vertical cylinder of radius Radius
// around (X, Z), giving Lift m/s below world height Top. The chemistry engine
// (WP15) will feed the UpdraftField hook from burn state; until then the zone
// reads columns from LODESTONE_ZONE_DEBUG_UPDRAFTS and the client from
// ?updraft=..., same syntax (TS twin: client/src/sim/updraft.ts).
type Column struct{ X, Z, Radius, Top, Lift float64 }

// Columns implements UpdraftField: the strongest column containing the point.
type Columns []Column

// LiftAt implements UpdraftField.
func (cs Columns) LiftAt(x, y, z float64) float64 {
	best := 0.0
	for _, c := range cs {
		dx, dz := x-c.X, z-c.Z
		if float64(dx*dx)+float64(dz*dz) <= c.Radius*c.Radius && y <= c.Top && c.Lift > best {
			best = c.Lift
		}
	}
	return best
}

// ParseColumns parses "x,z,radius,top,lift[;...]"; malformed entries are
// skipped, like the client's parseUpdrafts.
func ParseColumns(spec string) Columns {
	var out Columns
	for _, part := range strings.Split(spec, ";") {
		f := strings.Split(part, ",")
		if len(f) != 5 {
			continue
		}
		var v [5]float64
		ok := true
		for i, s := range f {
			n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
			if err != nil {
				ok = false
				break
			}
			v[i] = n
		}
		if ok {
			out = append(out, Column{v[0], v[1], v[2], v[3], v[4]})
		}
	}
	return out
}
