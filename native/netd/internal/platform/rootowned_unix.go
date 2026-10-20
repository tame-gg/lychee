//go:build linux || darwin

package platform

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func RootOnly(dir string) error {
	for d := dir; d != "/"; d = filepath.Dir(d) {
		fi, err := os.Stat(d)
		if err != nil {
			return err
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s is writable by non-root users", d)
		}
	}
	return nil
}

func RootFile(p string) bool {
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0 && fi.Mode().Perm()&0o022 == 0
}

func SelfCheck(exe string) error {
	if exe == "" {
		return errors.New("executable path unknown")
	}
	if !filepath.IsAbs(exe) {
		return fmt.Errorf("executable path %q is not absolute", exe)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	if !RootFile(resolved) {
		return fmt.Errorf("%s is not a root-owned, non-writable regular file", resolved)
	}
	for _, p := range []string{exe, resolved} {
		if err := RootOnly(filepath.Dir(p)); err != nil {
			return err
		}
	}
	return nil
}

func CopyRootOwned(dst string) error {
	if err := RootOnly(filepath.Dir(dst)); err != nil {
		return err
	}
	src, err := os.Executable()
	if err != nil {
		return err
	}
	if src == dst {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Chown(tmp, 0, 0); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}
