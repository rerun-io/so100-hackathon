"""The tiny stdout protocol between the setup CLI tools and the local data server.

The course site's Set-up page drives ``log-so100`` / ``calibrate-so100`` / ``teleop-so100``
through the server (``POST /setup/start``), which spawns them as subprocesses. The tools
announce where they are by printing one marker line per phase change; the server tails
stdout and mirrors the current phase into ``GET /status`` so the page can label its
buttons (NEXT STEP vs NEXT ARM vs FINISH). Human-driven terminal use is unaffected --
the markers are just one extra line.
"""

from __future__ import annotations

PHASE_PREFIX = "[setup] phase="

# Phases announced by the tools:
#   calibrate-so100:  "wiggle" (only when several arms are plugged in) -> "middle" -> "sweep"
#   log-so100:        "running" (arms open, telemetry streaming)


def announce_phase(name: str) -> None:
    """Print a phase marker for the data server to pick up (no-op noise for humans)."""
    print(f"{PHASE_PREFIX}{name}", flush=True)
