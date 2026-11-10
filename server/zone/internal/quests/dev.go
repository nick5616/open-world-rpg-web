package quests

// Playtest 2 dev console (docs/cr/032-dev-console.md): finish a quest's
// current step whatever its objective (the glue then pays the step's grant
// and, at the end, the quest's rewards exactly as a real completion does).

// DevAdvance completes quest id's current step. The happening says which
// step finished and whether the quest did (it is then removed and marked
// done); ok is false for an unknown or finished quest.
func (l *Log) DevAdvance(id uint32) (Happening, bool) {
	q := l.Find(id)
	if q == nil || q.Current() == nil {
		return Happening{}, false
	}
	h := Happening{Quest: q, Step: q.Step}
	q.Step++
	q.Progress, q.Count = 0, 0
	l.dirty = true
	if q.Current() == nil {
		l.Remove(q.ID)
		l.markDone(q.Key)
		h.Finished = true
	}
	return h, true
}
