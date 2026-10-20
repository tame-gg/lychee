//go:build ignore

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"sync/atomic"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run smokeclient.go <control-socket> [one-shot-command]")
		os.Exit(2)
	}
	conn, err := net.Dial("unix", os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer conn.Close()

	var id int64
	send := func(cmd string, args map[string]any) {
		n := atomic.AddInt64(&id, 1)
		req := map[string]any{"id": n, "cmd": cmd}
		if args != nil {
			req["args"] = args
		}
		b, _ := json.Marshal(req)
		conn.Write(append(b, '\n'))
	}

	send("hello", map[string]any{"protocol": []int{1}, "client": "smoke", "client_version": "0.0.0"})

	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(conn)
		sc.Buffer(make([]byte, 0, 1024), 1<<20)
		for sc.Scan() {
			fmt.Println(sc.Text())
		}
		close(done)
	}()

	drive := func(line string) {
		line = strings.TrimSpace(line)
		if line == "" {
			return
		}
		if strings.HasPrefix(line, "{") {
			conn.Write(append([]byte(line), '\n'))
			return
		}
		switch line {
		case "on", "off", "status", "quit", "unsubscribe", "list_adapters", "cleanup":
			send(line, nil)
		case "subscribe":
			send("subscribe", map[string]any{"interval_ms": 1000})
		default:
			fmt.Fprintln(os.Stderr, "unknown command:", line)
		}
	}

	if len(os.Args) >= 3 {
		drive(os.Args[2])
		<-done
		return
	}
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		drive(in.Text())
	}
	<-done
}
