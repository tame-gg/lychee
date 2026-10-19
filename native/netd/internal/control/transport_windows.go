package control

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const pipePrefix = `\\.\pipe\lychee-netd-`

var (
	modkernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	procGetNamedPipeClientProcID = modkernel32.NewProc("GetNamedPipeClientProcessId")
	modadvapi32                  = windows.NewLazySystemDLL("advapi32.dll")
	procCheckTokenMembership     = modadvapi32.NewProc("CheckTokenMembership")
)

func Listen(path string) (*Transport, int, error) {
	if code, err := requireElevatedAdmin(); err != nil {
		return nil, code, err
	}
	sid, err := ownUserSID()
	if err != nil {
		return nil, ExitRefused, err
	}
	want := pipePrefix + sid.String()
	if path != want {
		return nil, ExitRefused, fmt.Errorf("pipe name must be %s", want)
	}
	sddl := fmt.Sprintf("O:%sD:P(A;;GRGW;;;%s)(A;;GA;;;SY)", sid.String(), sid.String())
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, ExitTransport, err
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	first, err := createPipeInstance(path, sa, true)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_PIPE_BUSY) {
			return nil, ExitTransport, fmt.Errorf("pipe name already in use: %w", err)
		}
		return nil, ExitTransport, err
	}
	ln := &pipeListener{path: path, sa: sa, next: first}
	sidStr := sid.String()
	return &Transport{
		Listener:  ln,
		Auth:      AuthInfo{Model: "windows_pipe_sid", Privilege: "elevated", SID: &sidStr},
		PeerCheck: pipePeerCheck(sid),
		cleanup:   func() { ln.Close() },
	}, ExitOK, nil
}

func requireElevatedAdmin() (int, error) {
	token := windows.GetCurrentProcessToken()
	if !token.IsElevated() {
		return ExitNeedsAdmin, errors.New("the network helper needs an elevated administrator token")
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return ExitNeedsAdmin, err
	}
	var isMember int32
	r, _, e := procCheckTokenMembership.Call(0, uintptr(unsafe.Pointer(admins)), uintptr(unsafe.Pointer(&isMember)))
	if r == 0 {
		return ExitNeedsAdmin, e
	}
	if isMember == 0 {
		return ExitNeedsAdmin, errors.New("the helper's token is not a member of Administrators")
	}
	return ExitOK, nil
}

func ownUserSID() (*windows.SID, error) {
	token := windows.GetCurrentProcessToken()
	u, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid, nil
}

func createPipeInstance(path string, sa *windows.SecurityAttributes, first bool) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	openMode := uint32(windows.PIPE_ACCESS_DUPLEX | windows.FILE_FLAG_OVERLAPPED)
	if first {
		openMode |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
	}
	pipeMode := uint32(windows.PIPE_TYPE_BYTE | windows.PIPE_READMODE_BYTE | windows.PIPE_WAIT | windows.PIPE_REJECT_REMOTE_CLIENTS)
	h, err := windows.CreateNamedPipe(name, openMode, pipeMode, 4, 65536, 65536, 0, sa)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return h, nil
}

type pipeListener struct {
	mu     sync.Mutex
	path   string
	sa     *windows.SecurityAttributes
	next   windows.Handle
	closed bool
}

func (l *pipeListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, errors.New("listener closed")
	}
	h := l.next
	l.mu.Unlock()

	if err := connectPipe(h); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}

	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		windows.DisconnectNamedPipe(h)
		windows.CloseHandle(h)
		return nil, errors.New("listener closed")
	}
	nh, err := createPipeInstance(l.path, l.sa, false)
	if err == nil {
		l.next = nh
	}
	l.mu.Unlock()
	return newPipeConn(h), nil
}

func (l *pipeListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if l.next != windows.InvalidHandle && l.next != 0 {
		windows.CancelIoEx(l.next, nil)
		windows.CloseHandle(l.next)
	}
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr(l.path) }

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }

func connectPipe(h windows.Handle) error {
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(ev)
	ov := &windows.Overlapped{HEvent: ev}
	err = windows.ConnectNamedPipe(h, ov)
	if err == nil || errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return nil
	}
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		return err
	}
	if _, err := windows.WaitForSingleObject(ev, windows.INFINITE); err != nil {
		return err
	}
	var transferred uint32
	return windows.GetOverlappedResult(h, ov, &transferred, false)
}

type pipeConn struct {
	h      windows.Handle
	mu     sync.Mutex
	closed bool
	rdDead time.Time
	wrDead time.Time
}

func newPipeConn(h windows.Handle) *pipeConn { return &pipeConn{h: h} }

func (c *pipeConn) handle() windows.Handle { return c.h }

func (c *pipeConn) op(p []byte, write bool, deadline time.Time) (int, error) {
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(ev)
	ov := &windows.Overlapped{HEvent: ev}
	var done uint32
	if write {
		err = windows.WriteFile(c.h, p, &done, ov)
	} else {
		err = windows.ReadFile(c.h, p, &done, ov)
	}
	if err != nil && errors.Is(err, windows.ERROR_IO_PENDING) {
		timeout := uint32(windows.INFINITE)
		if !deadline.IsZero() {
			ms := time.Until(deadline).Milliseconds()
			if ms <= 0 {
				windows.CancelIoEx(c.h, ov)
				return 0, timeoutError{}
			}
			timeout = uint32(ms)
		}
		s, werr := windows.WaitForSingleObject(ev, timeout)
		if werr != nil {
			return 0, werr
		}
		if s == uint32(windows.WAIT_TIMEOUT) {
			windows.CancelIoEx(c.h, ov)
			return 0, timeoutError{}
		}
		err = windows.GetOverlappedResult(c.h, ov, &done, false)
	}
	if err != nil {
		return int(done), err
	}
	return int(done), nil
}

func (c *pipeConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	d := c.rdDead
	c.mu.Unlock()
	n, err := c.op(p, false, d)
	if err != nil && n == 0 {
		return 0, err
	}
	return n, err
}

func (c *pipeConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	d := c.wrDead
	c.mu.Unlock()
	return c.op(p, true, d)
}

func (c *pipeConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	windows.CancelIoEx(c.h, nil)
	windows.DisconnectNamedPipe(c.h)
	return windows.CloseHandle(c.h)
}

func (c *pipeConn) LocalAddr() net.Addr  { return pipeAddr("lychee-netd") }
func (c *pipeConn) RemoteAddr() net.Addr { return pipeAddr("client") }

func (c *pipeConn) SetDeadline(t time.Time) error {
	c.SetReadDeadline(t)
	c.SetWriteDeadline(t)
	return nil
}

func (c *pipeConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.rdDead = t
	c.mu.Unlock()
	return nil
}

func (c *pipeConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.wrDead = t
	c.mu.Unlock()
	return nil
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func pipePeerCheck(authSID *windows.SID) func(net.Conn) (PeerInfo, error) {
	return func(nc net.Conn) (PeerInfo, error) {
		pc, ok := nc.(*pipeConn)
		if !ok {
			return PeerInfo{}, errors.New("not a pipe connection")
		}
		var pid uint32
		r, _, e := procGetNamedPipeClientProcID.Call(uintptr(pc.handle()), uintptr(unsafe.Pointer(&pid)))
		if r == 0 {
			return PeerInfo{}, e
		}
		proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if err != nil {
			return PeerInfo{PID: int(pid)}, err
		}
		defer windows.CloseHandle(proc)
		var token windows.Token
		if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token); err != nil {
			return PeerInfo{PID: int(pid)}, err
		}
		defer token.Close()
		u, err := token.GetTokenUser()
		if err != nil {
			return PeerInfo{PID: int(pid)}, err
		}
		info := PeerInfo{PID: int(pid), SID: u.User.Sid.String()}
		if !windows.EqualSid(u.User.Sid, authSID) {
			return info, fmt.Errorf("client sid %s is not authorized", info.SID)
		}
		return info, nil
	}
}
