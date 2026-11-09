package game

import (
	"sync/atomic"
	"testing"
	"time"
)

// lateContainers is a container source whose chunk "finishes generating"
// after the player arrived (the zone's terrain cache lists only built chunks).
type lateContainers struct{ ready atomic.Bool }

func (c *lateContainers) ContainersNear(x, z, r float64) []ContainerInfo {
	if !c.ready.Load() {
		return nil
	}
	return []ContainerInfo{{ID: 4242, X: 702, Y: 0, Z: 700, Kind: 0, Level: 1, Element: -1}}
}

// G4: a container whose chunk is generated after the player entered that
// chunk must still reach the client (Event 406) without crossing a chunk
// border; before, the list was sent once per chunk and the chest never got
// its [E] prompt (seen in the G4 browser run as a chest that would not open).
func TestContainerListResentWhenALateChunkArrives(t *testing.T) {
	src := &lateContainers{}
	h := newHarness(t, func(c *Config) { c.Items = &ItemsSetup{Containers: src} })
	a := h.dial(spawnAt(700, 700))
	a.join(h, "late-chest", "Looter")
	a.pump(1500 * time.Millisecond)
	for _, e := range a.eventsOf(EventContainers) {
		if e.Value != 0 {
			t.Fatalf("container listed before its chunk existed: %+v", e)
		}
	}
	src.ready.Store(true) // the chunk finished generating; the player has not moved
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.pump(100 * time.Millisecond)
		evs := a.eventsOf(EventContainers)
		if len(evs) > 0 && evs[len(evs)-1].Value == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the late container never reached the client (%d container events)", len(evs))
		}
	}
	// And it opens.
	a.interact(InteractContainer, 4242, ActionUse, 0)
	if ev := a.lastEvent(EventContainerOpened, 3*time.Second); ev == nil {
		t.Fatal("not opened")
	}
}
