package wake

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Fake is an in-process VM: Start moves it to Starting, and it reports
// Running once BootTime has passed (Stop likewise takes StopTime). Tests
// drive it with a fake clock; the local rehearsal selects it with
// LODESTONE_WAKE_PROVIDER=fake to show the "waking the world" screen without
// any cloud.
type Fake struct {
	BootTime time.Duration
	StopTime time.Duration
	Now      func() time.Time

	mu        sync.Mutex
	state     State
	changedAt time.Time
	lastStart time.Time
	Starts    int
	Stops     int
	// FailStatus makes Status return an error (provider outage tests).
	FailStatus bool
}

// NewFake returns a stopped fake VM.
func NewFake(boot time.Duration, now func() time.Time) *Fake {
	return &Fake{BootTime: boot, Now: now, state: Stopped}
}

func (f *Fake) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

// Name implements Provider.
func (f *Fake) Name() string { return "fake" }

// advance settles transitional states whose time has come. Caller holds mu.
func (f *Fake) advance() {
	now := f.now()
	switch f.state {
	case "":
		f.state = Stopped
	case Starting:
		if now.Sub(f.changedAt) >= f.BootTime {
			f.state, f.changedAt, f.lastStart = Running, now, now
		}
	case Stopping:
		if now.Sub(f.changedAt) >= f.StopTime {
			f.state, f.changedAt = Stopped, now
		}
	}
}

// Status implements Provider.
func (f *Fake) Status(context.Context) (Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailStatus {
		return Status{}, errors.New("fake provider outage")
	}
	f.advance()
	return Status{State: f.state, LastStart: f.lastStart}, nil
}

// Start implements Provider.
func (f *Fake) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.advance()
	if f.state != Stopped {
		return errors.New("fake: start while " + string(f.state))
	}
	f.Starts++
	f.state, f.changedAt = Starting, f.now()
	f.advance() // BootTime 0 = instantly running
	return nil
}

// Stop implements Provider.
func (f *Fake) Stop(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.advance()
	if f.state != Running {
		return errors.New("fake: stop while " + string(f.state))
	}
	f.Stops++
	f.state, f.changedAt = Stopping, f.now()
	f.advance()
	return nil
}

// SetRunning forces the fake into Running (tests).
func (f *Fake) SetRunning(at time.Time) {
	f.mu.Lock()
	f.state, f.changedAt, f.lastStart = Running, at, at
	f.mu.Unlock()
}

// MemoryActivity is an ActivityStore for tests and for a director without
// Redis.
type MemoryActivity struct {
	mu   sync.Mutex
	last time.Time
	// Fail makes every call return an error (unreachable store tests).
	Fail bool
}

// Touch implements ActivityStore.
func (m *MemoryActivity) Touch(_ context.Context, t time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail {
		return errors.New("store unreachable")
	}
	if t.After(m.last) {
		m.last = t
	}
	return nil
}

// Last implements ActivityStore.
func (m *MemoryActivity) Last(context.Context) (time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail {
		return time.Time{}, errors.New("store unreachable")
	}
	return m.last, nil
}
