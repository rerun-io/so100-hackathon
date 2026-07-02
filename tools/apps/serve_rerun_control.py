"""Host a Rerun proxy, an OSS web viewer, and a custom control server together.

Three servers are started on three ports:

* ``--grpc-port``    (default 9876): a Rerun gRPC *proxy* server (``rr.serve_grpc``).
* ``--viewer-port``  (default 9090): the OSS Rerun web-viewer assets
  (``rr.start_web_viewer_server``) -- i.e. the viewer HTML/wasm hosted locally
  instead of from ``app.rerun.io``.
* ``--control-port`` (default 8000): a small stdlib HTTP "control server" that
  serves the combined HTML page and handles the ``start`` / ``stop`` buttons.

The combined HTML page (served by the control server at ``/``) embeds the OSS
web viewer in an iframe -- so the viewer is loaded from the local OSS server and
connected to the local proxy server -- in the top 80%, and puts a simple
control bar with "start" / "stop" buttons in the bottom 20%.

Run it with::

    pixi run python tools/apps/serve_rerun_control.py

then open http://localhost:8000
"""

from __future__ import annotations

import dataclasses
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import rerun as rr
import tyro


@dataclasses.dataclass
class Config:
    """Ports for the three servers."""

    grpc_port: int = 9876
    """Port for the Rerun gRPC proxy server."""

    viewer_port: int = 9090
    """Port for the OSS Rerun web-viewer assets."""

    control_port: int = 8000
    """Port for the custom control server (also serves the HTML page)."""

    open_browser: bool = True
    """Open the combined page in the default browser on startup."""


class Streamer:
    """Background thread that logs animated data to the proxy while running."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def start(self) -> bool:
        """Start streaming. Returns True if it was started, False if already running."""
        with self._lock:
            if self.running:
                return False
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="streamer", daemon=True)
            self._thread.start()
            return True

    def stop(self) -> bool:
        """Stop streaming. Returns True if it was stopped, False if not running."""
        with self._lock:
            if not self.running:
                return False
            self._stop.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        return True

    def _run(self) -> None:
        step = 0
        while not self._stop.is_set():
            t = step * 0.05
            rr.set_time("step", sequence=step)

            # A spinning point cloud so there is something to look at.
            angles = np.linspace(0.0, 2.0 * math.pi, 64, endpoint=False) + t
            radius = 1.0 + 0.25 * math.sin(t)
            positions = np.column_stack(
                [
                    radius * np.cos(angles),
                    radius * np.sin(angles),
                    0.15 * np.sin(3.0 * angles + t),
                ]
            )
            colors = np.column_stack(
                [
                    (0.5 + 0.5 * np.sin(angles)) * 255,
                    (0.5 + 0.5 * np.cos(angles)) * 255,
                    np.full_like(angles, 200.0),
                ]
            ).astype(np.uint8)
            rr.log("world/points", rr.Points3D(positions, colors=colors, radii=0.05))

            # A scalar plot.
            rr.log("plot/sine", rr.Scalars(math.sin(t)))

            step += 1
            time.sleep(1.0 / 30.0)


def build_page(viewer_port: int, grpc_port: int) -> str:
    """HTML: top 80% embedded OSS viewer connected to the proxy, bottom 20% controls."""

    # The OSS web viewer reads `?url=` and connects to that gRPC data source.
    proxy_uri = f"rerun+http://localhost:{grpc_port}/proxy"
    viewer_src = f"http://localhost:{viewer_port}/?url={proxy_uri}"

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rerun control</title>
  <style>
    html, body {{ margin: 0; height: 100%; font-family: system-ui, sans-serif; }}
    #app {{ display: flex; flex-direction: column; height: 100vh; }}
    #viewer {{ flex: 0 0 80%; border: 0; width: 100%; }}
    #controls {{
      flex: 0 0 20%;
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0 1.5rem;
      background: #1b1b1f;
      color: #eee;
      box-sizing: border-box;
    }}
    button {{
      font-size: 1.25rem;
      padding: 0.6rem 2rem;
      border: 0;
      border-radius: 0.5rem;
      cursor: pointer;
      color: #fff;
    }}
    #start {{ background: #2e7d32; }}
    #stop  {{ background: #c62828; }}
    button:disabled {{ opacity: 0.4; cursor: default; }}
    #status {{ margin-left: auto; font-variant-numeric: tabular-nums; }}
  </style>
</head>
<body>
  <div id="app">
    <iframe id="viewer" src="{viewer_src}" allow="fullscreen"></iframe>
    <div id="controls">
      <button id="start">start</button>
      <button id="stop">stop</button>
      <span id="status">…</span>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById("status");
    const startBtn = document.getElementById("start");
    const stopBtn = document.getElementById("stop");

    function render(state) {{
      const running = !!(state && state.running);
      statusEl.textContent = running ? "streaming" : "stopped";
      startBtn.disabled = running;
      stopBtn.disabled = !running;
    }}

    async function call(path) {{
      try {{
        const res = await fetch(path, {{ method: "POST" }});
        render(await res.json());
      }} catch (err) {{
        statusEl.textContent = "error: " + err;
      }}
    }}

    async function refresh() {{
      try {{
        const res = await fetch("/status");
        render(await res.json());
      }} catch (err) {{
        statusEl.textContent = "control server unreachable";
      }}
    }}

    startBtn.addEventListener("click", () => call("/start"));
    stopBtn.addEventListener("click", () => call("/stop"));
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>
"""


def make_handler(streamer: Streamer, page: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # noqa: A003 - silence request logging
            pass

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self) -> None:
            import json

            body = json.dumps({"running": streamer.running}).encode("utf-8")
            self._send(200, body, "application/json")

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            elif path == "/status":
                self._send_json()
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/start":
                streamer.start()
                self._send_json()
            elif path == "/stop":
                streamer.stop()
                self._send_json()
            else:
                self._send(404, b"not found", "text/plain")

    return Handler


def main(config: Config) -> None:
    # A recording is required for the gRPC proxy to attach to; the streamer logs to it.
    rr.init("newtheory_hackathon")

    # 1) gRPC proxy server -- this is for the live view of the data
    proxy_uri = rr.serve_grpc(grpc_port=config.grpc_port)
    print(f"Live proxy server:  {proxy_uri}")

    # 2) OSS web-viewer assets -- the viewer HTML/wasm hosted locally.
    rr.start_web_viewer_server(port=config.viewer_port)
    print(f"OSS web viewer:     http://localhost:{config.viewer_port}")

    # 3) Control server -- serves the combined HTML page and the start/stop API.
    streamer = Streamer()
    page = build_page(config.viewer_port, config.grpc_port)
    handler = make_handler(streamer, page)
    httpd = ThreadingHTTPServer(("localhost", config.control_port), handler)
    page_url = f"http://localhost:{config.control_port}"
    print(f"Control server:     {page_url}  (open this)")

    if config.open_browser:
        import webbrowser

        webbrowser.open(page_url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        streamer.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main(tyro.cli(Config))
