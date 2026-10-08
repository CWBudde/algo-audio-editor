//go:build !js

package automation

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// MaxInputBytes bounds file/chain reads before the kernel sees them. The
// kernel additionally enforces its own decoded-codec and processing budgets.
const MaxInputBytes = 128 << 20

// ReadFile reads a regular file within the supplied byte limit.
func ReadFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path) // #nosec G304 -- Native CLI/MCP deliberately permits user-selected reads; regular-file and byte limits are checked on this descriptor.
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("read file: stat: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("read file: requires a regular file of at most %d bytes", limit)
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("read file: exceeds %d bytes", limit)
	}
	return data, nil
}

type writeRoot struct {
	path string
	root *os.Root
}

// FilePolicy uses os.Root for traversal-resistant writes, including symlink
// races. An empty policy permits in-memory editing but no filesystem writes.
type FilePolicy struct {
	roots []writeRoot
}

// NewFilePolicy opens traversal-resistant roots for explicitly allowed writes.
func NewFilePolicy(directories []string) (*FilePolicy, error) {
	p := new(FilePolicy)
	for _, directory := range directories {
		absolute, err := filepath.Abs(directory)
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("allow-write: absolute path: %w", err)
		}
		canonical, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("allow-write: resolve directory: %w", err)
		}
		root, err := os.OpenRoot(canonical)
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("allow-write: open root: %w", err)
		}
		p.roots = append(p.roots, writeRoot{path: canonical, root: root})
	}
	return p, nil
}

// Close closes all allowed filesystem roots.
func (p *FilePolicy) Close() {
	for _, root := range p.roots {
		_ = root.root.Close()
	}
}

// destination maps path onto an allowed root. It returns the root, the path
// relative to it, the absolute path as the caller spelled it (for reporting)
// and the canonical absolute path (for comparing destinations).
func (p *FilePolicy) destination(path string) (*os.Root, string, string, string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, "", "", "", fmt.Errorf("export: absolute path: %w", err)
	}
	canonical := canonicalDestination(absolute)
	for _, root := range p.roots {
		relative, err := filepath.Rel(root.path, canonical)
		if err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			return root.root, relative, absolute, canonical, nil
		}
	}
	return nil, "", "", "", fmt.Errorf("export: path is outside allowed write roots; start the server with --allow-write <existing-directory>")
}

// canonicalDestination resolves symlinks in the parent directories of a
// cleaned absolute path the same way NewFilePolicy resolves its roots, so a
// root and a destination spelled through different links (macOS /tmp versus
// /private/tmp, Windows 8.3 short names) still compare equal. Directories that
// do not exist yet are re-appended to the deepest ancestor that resolves. The
// final element is kept as given: publishing replaces that directory entry and
// never follows a symlink there. This only selects the root and relative path;
// os.Root still rejects any symlink that escapes it while writing.
func canonicalDestination(absolute string) string {
	name := filepath.Base(absolute)
	directory := filepath.Dir(absolute)
	if directory == absolute {
		return absolute
	}
	missing := []string{name}
	for {
		resolved, err := filepath.EvalSymlinks(directory)
		if err == nil {
			slices.Reverse(missing)
			return filepath.Join(append([]string{resolved}, missing...)...)
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return absolute
		}
		missing = append(missing, filepath.Base(directory))
		directory = parent
	}
}

// Write stages bytes beside the destination, then publishes atomically. Link
// provides no-replace semantics without a check-then-write race. Rename with
// explicit overwrite replaces the directory entry, never a symlink's target.
func (p *FilePolicy) Write(path string, data []byte, overwrite bool) (string, error) {
	root, relative, absolute, _, err := p.destination(path)
	if err != nil {
		return "", err
	}
	temporary := filepath.Join(filepath.Dir(relative), ".aae-"+rand.Text()+".tmp")
	f, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("export: create staging file (parent directory must exist): %w", err)
	}
	defer func() { _ = root.Remove(temporary) }()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("export: write staging file: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("export: sync staging file: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("export: close staging file: %w", err)
	}
	if overwrite {
		err = root.Rename(temporary, relative)
	} else {
		err = root.Link(temporary, relative)
	}
	if err != nil {
		return "", fmt.Errorf("export: publish file (use overwrite:true only to replace an existing file): %w", err)
	}
	return absolute, nil
}
