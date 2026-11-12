# 原生 Shell_NotifyIconW 对照：不经过 Electron，直接问 Windows 接不接受新托盘图标。
# 用法：python tools/tray_native_probe.py
import ctypes
import time
from ctypes import wintypes

user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

# 64 位下 wintypes.LPARAM/WPARAM 是 32 位的 c_long，必须自己定义，否则回调参数溢出。
LPARAM = ctypes.c_ssize_t
WPARAM = ctypes.c_size_t
LRESULT = ctypes.c_ssize_t

user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.CreateWindowExW.restype = wintypes.HWND
user32.LoadIconW.restype = wintypes.HICON
shell32.Shell_NotifyIconW.restype = wintypes.BOOL

WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, WPARAM, LPARAM)


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),

        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR),
    ]


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT), ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128), ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256), ("uTimeoutOrVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64), ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wintypes.HICON),
    ]


def wndproc(hwnd, msg, wparam, lparam):
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


proc = WNDPROC(wndproc)
hinst = kernel32.GetModuleHandleW(None)
wc = WNDCLASSW()
wc.lpfnWndProc = proc
wc.hInstance = hinst
wc.lpszClassName = "NativeTrayProbeWnd"
if not user32.RegisterClassW(ctypes.byref(wc)):
    print("RegisterClassW failed:", ctypes.GetLastError())

hwnd = user32.CreateWindowExW(0, "NativeTrayProbeWnd", "probe", 0, 0, 0, 0, 0, None, None, hinst, None)
print("hwnd =", hwnd, "err =", ctypes.GetLastError())

nid = NOTIFYICONDATAW()
nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
nid.hWnd = hwnd
nid.uID = 1
nid.uFlags = 0x1 | 0x2 | 0x4  # NIF_MESSAGE | NIF_ICON | NIF_TIP
nid.uCallbackMessage = 0x8000 + 1  # WM_APP + 1
nid.hIcon = user32.LoadIconW(None, 32516)  # IDI_INFORMATION
nid.szTip = "NATIVE-TRAY-PROBE"
print("sizeof(nid) =", nid.cbSize, "hIcon =", nid.hIcon)

ok = shell32.Shell_NotifyIconW(0, ctypes.byref(nid))  # NIM_ADD
print("Shell_NotifyIconW(NIM_ADD) ->", bool(ok), "err =", ctypes.GetLastError())

# NOTIFYICON_VERSION_4
nid.uTimeoutOrVersion = 4
ok2 = shell32.Shell_NotifyIconW(4, ctypes.byref(nid))  # NIM_SETVERSION
print("Shell_NotifyIconW(NIM_SETVERSION) ->", bool(ok2))

msg = wintypes.MSG()
end = time.time() + 12
while time.time() < end:
    while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    time.sleep(0.05)

shell32.Shell_NotifyIconW(2, ctypes.byref(nid))  # NIM_DELETE
user32.DestroyWindow(hwnd)
print("done")
