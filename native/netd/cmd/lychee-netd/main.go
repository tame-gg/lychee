package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"github.com/tame-gg/lychee/native/netd/internal/control"
	"github.com/tame-gg/lychee/native/netd/internal/logx"
	"github.com/tame-gg/lychee/native/netd/internal/platform"
)

var version = "dev"

const usage = `lychee-netd: Lychee's privileged network helper.

  lychee-netd serve --control <path>   run the engine behind the control channel
  lychee-netd version                  print the build version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(control.ExitUsage)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println("lychee-netd", version)
	case "serve":
		os.Exit(serve(os.Args[2:]))
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(control.ExitUsage)
	}
}

func serve(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	controlPath := fs.String("control", "", "control socket or named-pipe path")
	if err := fs.Parse(args); err != nil {
		return control.ExitUsage
	}
	if *controlPath == "" || fs.NArg() != 0 {
		fmt.Fprint(os.Stderr, usage)
		return control.ExitUsage
	}

	if code, err := control.CheckPrivilege(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return code
	}
	if code, err := control.SelfCheck(os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return code
	}
	if platform.NetMergeRunning() {
		fmt.Fprintln(os.Stderr, "another connection-merging tool is running")
		return control.ExitConflict
	}
	if !platform.SingleInstance() {
		fmt.Fprintln(os.Stderr, "another connection-merging tool is running")
		return control.ExitConflict
	}

	capture := control.CaptureStatus{Available: true}
	if err := platform.CheckDriver(); err != nil {
		capture.Available = false
		capture.Error = err.Error()
	}

	tr, code, err := control.Listen(*controlPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return code
	}
	defer tr.Close()

	eng := newRealEngine()
	eng.start()
	defer eng.close()

	caps := []string{"link_counters"}
	if runtime.GOOS == "darwin" {
		caps = append(caps, "keep_adapter_on_off")
	}

	srv := control.New(control.Config{
		Listener:     tr.Listener,
		PeerCheck:    tr.PeerCheck,
		Clock:        control.RealClock(),
		Engine:       eng,
		Version:      version,
		Auth:         tr.Auth,
		Capabilities: caps,
		Capture:      capture,
		Stderr:       os.Stderr,
	})

	logx.SetOutput(&logSink{w: os.Stderr, srv: srv})

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-sig
		srv.Shutdown()
	}()

	fmt.Fprintln(os.Stderr, "listening on", *controlPath)
	return srv.Serve()
}

type logSink struct {
	mu  sync.Mutex
	w   io.Writer
	srv *control.Server
	buf []byte
}

func (l *logSink) Write(p []byte) (int, error) {
	l.mu.Lock()
	l.w.Write(p)
	l.buf = append(l.buf, p...)
	for {
		i := strings.IndexByte(string(l.buf), '\n')
		if i < 0 {
			break
		}
		line := string(l.buf[:i])
		l.buf = l.buf[i+1:]
		level, msg := classify(line)
		if msg != "" {
			l.srv.Log(level, msg)
		}
	}
	l.mu.Unlock()
	return len(p), nil
}

func classify(line string) (string, string) {
	line = strings.TrimRight(line, "\r")
	switch {
	case strings.HasPrefix(line, "error:"):
		return "error", strings.TrimSpace(line[len("error:"):])
	case strings.HasPrefix(line, "warning:"):
		return "warn", strings.TrimSpace(line[len("warning:"):])
	case line == "":
		return "info", ""
	default:
		return "info", line
	}
}
