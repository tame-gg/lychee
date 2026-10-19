//go:build windows

package control

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPipeNameMustMatchSID(t *testing.T) {
	_, code, err := Listen(`\\.\pipe\lychee-netd-S-1-5-18`)
	if err == nil || (code != ExitRefused && code != ExitNeedsAdmin) {
		t.Fatalf("a mismatched pipe name must be refused, got code %d err %v", code, err)
	}
}

func TestOwnPipeNameAccepted(t *testing.T) {
	sid, err := ownUserSID()
	if err != nil {
		t.Fatal(err)
	}
	want := pipePrefix + sid.String()
	if !strings.HasPrefix(want, `\\.\pipe\lychee-netd-S-1-5`) {
		t.Fatalf("unexpected pipe name %q", want)
	}
	tr, code, err := Listen(want)
	if err != nil {
		if code == ExitNeedsAdmin {
			t.Skip("not elevated")
		}
		t.Fatalf("Listen on own pipe name failed: code %d err %v", code, err)
	}
	defer tr.Close()
	if tr.Auth.Model != "windows_pipe_sid" || tr.Auth.SID == nil {
		t.Fatalf("auth wrong: %+v", tr.Auth)
	}
}

func TestElevatedTokenGate(t *testing.T) {
	code, err := requireElevatedAdmin()
	if err != nil && code != ExitNeedsAdmin {
		t.Fatalf("non-elevated should map to exit 6, got %d", code)
	}
	_ = windows.WinBuiltinAdministratorsSid
}
