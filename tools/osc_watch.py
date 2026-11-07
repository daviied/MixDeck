"""Print everything an X32 sends to a remote client. Run: python tools/osc_watch.py <ip> [filter]
Use it to see what a control on the desk sends. Example: press Layer up and down, and look for a new line."""
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
from x32 import osc_decode, osc_encode  # noqa: E402

ip = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else ""
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1)
last = 0.0
print(f"Watching {ip}. Press Ctrl+C to stop.", flush=True)
try:
    while True:
        if time.time() - last > 5:
            s.sendto(osc_encode("/xremote"), (ip, 10023))
            last = time.time()
        try:
            data, _ = s.recvfrom(65535)
        except socket.timeout:
            continue
        addr, args = osc_decode(data)
        if want in addr:
            print(f"{time.strftime('%H:%M:%S')} {addr} {args}", flush=True)
except KeyboardInterrupt:
    pass
