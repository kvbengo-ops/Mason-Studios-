package kie

// SupportsPromptOnlyVideo mirrors web/lib/prompt-only-video.ts for these endpoints.
func SupportsPromptOnlyVideo(modelID string) bool {
	switch modelID {
	case "seedance-2.5", "seedance-2", "seedance-2-fast", "seedance-2-mini", "kling-3.0-pro", "kling-4.0-reference", "wan-3.0":
		return true
	default:
		return false
	}
}
