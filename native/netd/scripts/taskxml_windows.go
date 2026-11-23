package main

import (
	"fmt"
	"os"

	"github.com/tame-gg/lychee/native/netd/internal/platform"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: taskxml <user> <exe> <control>")
		os.Exit(2)
	}
	fmt.Print(platform.TaskXML(os.Args[1], os.Args[2], os.Args[3]))
}
