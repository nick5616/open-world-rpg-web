package worldhost

// Towns (WP20): the towns_build export. The buffer is a pure function of
// the atlas (built once per instance, ~0.1-1 s), so hosts call it once per
// world; server/pkg/towns parses it and answers the building collision.

// TownsBytes runs towns_build: the world's towns buffer (worldgen/README.md
// "Towns"). A wasm built before WP20 lacks the export (error).
func (w *World) TownsBytes() ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCall("towns_build", uint64(in.atlasPtr))
}
