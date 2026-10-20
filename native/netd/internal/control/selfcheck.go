package control

import (
	"fmt"
	"io"
)

func selfCheckVerdict(stderr io.Writer, root, pkexec bool, checkErr error) (int, error) {
	switch {
	case !root || checkErr == nil:
		return ExitOK, nil
	case pkexec:
		fmt.Fprintf(stderr, "warning: self-check failed: %v; continuing because the helper was started with pkexec\n", checkErr)
		return ExitOK, nil
	default:
		return ExitRefused, fmt.Errorf("self-check failed: %w; the helper must be a root-owned binary that only root can write, in directories only root can write (install it from the package, or start it with pkexec)", checkErr)
	}
}
