package vertical

import (
	"testing"

	"lodestone/server/pkg/movement"
)

// Playtest 5 ("the underground has an invisible floor"): the world has a real
// bottom under the deepest content. Twin of worldgen/js/test/bedrock.test.ts.

// fallingBase is open air under a hillside: the cave ground's floor is 35 m
// under the feet, so a player there keeps falling.
type fallingBase struct{}

func (fallingBase) HeightAt(x, z float64) float64 { return 120 }
func (fallingBase) AtLevel(y float64) movement.Ground {
	return levelOf(y - 35)
}

type levelOf float64

func (l levelOf) HeightAt(x, z float64) float64 { return float64(l) }

type zeroSrc struct{}

func (zeroSrc) LayerHeight(surf int, x, z float64) float64 { return 0 }

func TestBedrockIsTheBottomOfTheWorld(t *testing.T) {
	if Bedrock >= -454.6-Ext {
		t.Fatalf("bedrock %v must be under the Depths (-454.6) and their %v m snap band", Bedrock, Ext)
	}
	w := &World{Domain: [3][]byte{make([]byte, 512), make([]byte, 512), make([]byte, 512)}}
	g := &Ground{Base: fallingBase{}, W: w, Src: zeroSrc{}}
	for _, c := range []struct{ y, want float64 }{
		{-460, -495}, // still falling
		{-480, Bedrock},
		{-900, Bedrock},
		{-100, -135}, // nothing above it changes
		{200, 165},
	} {
		if got := g.FloorAt(10, c.y, 10); got != c.want {
			t.Errorf("FloorAt(y=%v) = %v, want %v", c.y, got, c.want)
		}
	}
	if got := g.AtLevel(-2000).HeightAt(10, 10); got != Bedrock {
		t.Errorf("level view at -2000 = %v, want bedrock %v", got, Bedrock)
	}
}
