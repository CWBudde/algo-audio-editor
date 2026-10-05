package engine

// Older subsystem regressions now exercise the shared registry as well.
func (e *Engine) dispatchAnalysis(method string, payload []byte) (any, error) {
	return e.dispatch(method, payload, nil)
}

func (e *Engine) dispatchEditor(method string, payload []byte) (any, error) {
	return e.dispatch(method, payload, nil)
}

func (e *Engine) dispatchEffects(method string, payload, input []byte) (any, error) {
	return e.dispatch(method, payload, input)
}
