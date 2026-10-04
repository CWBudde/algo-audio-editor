// Package memory defines the shared kernel storage ceiling. Engine owns the
// available portion; lower-level factories accept stricter per-operation limits.
package memory

// StorageLimit leaves 1 GiB of the 4 GiB WASM address space for the Go runtime,
// decoder/DSP scratch, bridge copies, metadata and unreclaimed garbage. Native
// callers use the same ceiling so a native-produced document remains portable.
const StorageLimit int64 = 3 << 30
