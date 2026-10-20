//go:build linux || darwin

package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSelfCheckRefusesUnprivilegedBinary(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lychee-netd")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := SelfCheck(p); err == nil {
		t.Fatal("a binary outside a root-owned tree passed the self-check")
	}
	if err := SelfCheck("lychee-netd"); err == nil {
		t.Fatal("a relative path passed the self-check")
	}
	if err := SelfCheck(""); err == nil {
		t.Fatal("an empty path passed the self-check")
	}
}
