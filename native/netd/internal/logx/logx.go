package logx

import (
	"fmt"
	"io"
	"os"
)

var out io.Writer = os.Stdout

func SetOutput(w io.Writer) { out = w }

func Printf(format string, a ...any) { fmt.Fprintf(out, format, a...) }
