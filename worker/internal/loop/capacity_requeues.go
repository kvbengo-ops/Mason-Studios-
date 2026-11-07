package loop

import "sync"

// maxCapacityRequeues is how many times in a row one scene may go back to the
// queue for byteplus.ErrAtCapacity before it fails: ten 30s dispatch ticks,
// about five minutes.
const maxCapacityRequeues = 10

// CapacityRequeues counts each scene's consecutive capacity requeues.
//
// ponytail: in-memory, so a worker restart resets every count; a column on
// scenes if a stuck count ever has to survive restarts.
type CapacityRequeues struct {
	mu sync.Mutex
	n  map[string]int
}

// note records one more requeue for sceneID and returns the new count. A nil
// receiver always answers 1, so it never fails a scene.
func (c *CapacityRequeues) note(sceneID string) int {
	if c == nil {
		return 1
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n == nil {
		c.n = map[string]int{}
	}
	c.n[sceneID]++
	return c.n[sceneID]
}

// forget drops sceneID's count once the scene reaches a vendor or fails.
func (c *CapacityRequeues) forget(sceneID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.n, sceneID)
}
