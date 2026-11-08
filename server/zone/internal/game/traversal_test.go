package game

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
)

// TestValidationPassesEveryLegitMode feeds the WP10 golden inputs (climb,
// rain climb, kick-off, glide, updraft, swim + drowning, slopes, stamina on
// the official world) through Entity.applyFrame, i.e. the zone's real
// validation (verticalOK, per-mode speed bounds, world clamp). Legit
// traversal must never trip it, and the entity must end exactly where the
// client's prediction (the golden) says.
func TestValidationPassesEveryLegitMode(t *testing.T) {
	tr := testTerrain(t)
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "..", "client", "src", "sim", "golden", "movement_wp10_*.json"))
	if len(files) == 0 {
		t.Skip("client WP10 goldens not available")
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var g struct {
			Scenario string `json:"scenario"`
			Ground   struct {
				Structures string `json:"structures"`
			} `json:"ground"`
			Env struct {
				Raining  bool         `json:"raining"`
				Updrafts [][5]float64 `json:"updrafts"`
			} `json:"env"`
			StaminaMax int           `json:"staminaMax"`
			Initial    [12]float64   `json:"initial"`
			Frames     [][4]float64  `json:"frames"`
			States     [][12]float64 `json:"states"`
		}
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		for _, r := range g.States {
			tr.Want(r[0], r[2], 4)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		if err := tr.WaitIdle(ctx); err != nil {
			t.Fatal(err)
		}
		cancel()
		env := movement.Env{Raining: g.Env.Raining}
		var cs movement.Columns
		for _, u := range g.Env.Updrafts {
			cs = append(cs, movement.Column{X: u[0], Z: u[1], Radius: u[2], Top: u[3], Lift: u[4]})
		}
		if len(cs) > 0 {
			env.Updraft = cs
		}
		var ground movement.Ground = tr
		if g.Ground.Structures == "towers" {
			a, err := structures.ParseAtlas(tr.World().Atlas)
			if err != nil {
				t.Fatal(err)
			}
			o, _ := structures.Towers(a, tr)
			ground = structures.Wrap(tr, o) // what the zone runs since WP12
		}
		r := g.Initial
		e := &Entity{Move: movement.State{Pos: movement.Vec3{X: r[0], Y: r[1], Z: r[2]}, Mode: int(r[7]), Stamina: int(r[8]), StaminaMax: g.StaminaMax, Flags: uint8(r[11])}}
		e.prevValid = e.Move
		respawns := 0
		for i, fr := range g.Frames {
			if !e.applyFrame(proto.InputFrame{Seq: uint32(fr[0]), Flags: uint16(fr[1]), Yaw: uint16(fr[2]), Pitch: int16(fr[3])}, ground, env) {
				t.Fatalf("%s frame %d rejected by validation: %+v", g.Scenario, i, e.Move)
			}
			if e.drownedEvent {
				respawns++
				e.drownedEvent = false
			}
			w := g.States[i]
			if math.Abs(e.Move.Pos.X-w[0]) > 1e-9 || math.Abs(e.Move.Pos.Y-w[1]) > 1e-9 || math.Abs(e.Move.Pos.Z-w[2]) > 1e-9 || e.Move.Mode != int(w[7]) || e.Move.Stamina != int(w[8]) {
				t.Fatalf("%s frame %d: zone %+v vs golden %v", g.Scenario, i, e.Move, w)
			}
		}
		if g.Scenario == "swim" && respawns != 1 {
			t.Fatalf("swim: %d drowned events, want 1", respawns)
		}
		t.Logf("%s: %d frames applied, 0 violations, %d drowning respawns", g.Scenario, len(g.Frames), respawns)
	}
}

// Violations still snap back: a mode's speed bound and the vertical bound.
func TestPerModeValidationRejects(t *testing.T) {
	g := movement.Flat{Y: 0}
	climb := movement.NewState(movement.Vec3{Y: 0})
	climb.Mode = movement.ModeClimb
	fast := climb
	fast.Vel = movement.Vec3{X: constants.ClimbJumpSpeed + 1}
	if horizontalOK(climb, fast) {
		t.Fatal("climbing faster than a lunge must be rejected")
	}
	swim := movement.NewState(movement.Vec3{})
	swim.Mode = movement.ModeSwim
	swimFast := swim
	swimFast.Vel = movement.Vec3{X: constants.SwimSpeed + 1}
	if horizontalOK(swim, swimFast) {
		t.Fatal("swimming faster than SWIM_SPEED from rest must be rejected")
	}
	glide := movement.NewState(movement.Vec3{Y: 50})
	glide.Mode = movement.ModeGlide
	up := glide
	up.Pos.Y = 50 + (constants.UpdraftMaxLift+1)*movement.Dt
	if verticalOK(glide, up, g) {
		t.Fatal("rising faster than the strongest updraft must be rejected")
	}
	// A fake "respawn" (drowned flag cleared) must land on dry ground.
	drowned := swim
	drowned.Flags = movement.FlagDrowned
	lake := lakeGround{}
	bad := movement.NewState(movement.Vec3{X: 1, Y: -3})
	if verticalOK(drowned, bad, lake) {
		t.Fatal("respawn under water accepted")
	}
	good := movement.NewState(movement.Vec3{X: 20, Y: 1})
	if !verticalOK(drowned, good, lake) || !horizontalOK(drowned, good) {
		t.Fatal("respawn on the shore rejected")
	}
}

type lakeGround struct{}

func (lakeGround) HeightAt(x, _ float64) float64 {
	if x < 10 {
		return -3
	}
	return 1
}
func (lakeGround) WaterAt(_, _ float64) float64 { return 0 }

// stepEnv honors the debug overrides and otherwise asks the weather stub.
func TestStepEnv(t *testing.T) {
	yes := true
	s := &Server{cfg: Config{Seed: 20261108, Rain: &yes, Updraft: movement.Columns{{X: 1, Z: 2, Radius: 3, Top: 4, Lift: 5}}, Now: time.Now}}
	env := s.stepEnv()
	if !env.Raining || env.Updraft.LiftAt(1, 0, 2) != 5 {
		t.Fatalf("overrides ignored: %+v", env)
	}
	s.cfg.Rain = nil
	s.cfg.Now = func() time.Time { return time.UnixMilli(0) } // window 0 of seed 20261108 is dry
	if s.stepEnv().Raining {
		t.Fatal("weather stub: window 0 should be dry")
	}
	t.Setenv("LODESTONE_ZONE_DEBUG_UPDRAFTS", "10,20,5,100,6")
	t.Setenv("LODESTONE_ZONE_DEBUG_RAIN", "0")
	u, r := DebugEnvFromEnv()
	if u == nil || u.LiftAt(10, 50, 20) != 6 || r == nil || *r {
		t.Fatalf("DebugEnvFromEnv: %v %v", u, r)
	}
}
