package combat

// AllyName is an ally's player-facing name ("" for enemies; CR 020).
func (e *Enemy) AllyName() string {
	if e.ally == nil {
		return ""
	}
	return e.ally.def.Name
}

// AllyKey is an ally's summon key ("" for enemies).
func (e *Enemy) AllyKey() string {
	if e.ally == nil {
		return ""
	}
	return e.ally.def.Key
}
