"""One-time macOS setup: passwordless sudo for the realsense env's python.

macOS 12+ only lets root capture a kernel-claimed USB device (Apple's UVC driver
holds the RealSense), so `realsense-debug-sudo` runs the capture under sudo. This
installs a machine-local sudoers rule so that sudo never prompts::

    pixi run -e realsense realsense-sudo-setup             # asks for your password once
    pixi run -e realsense realsense-sudo-setup -- --remove # uninstall the rule

The rule whitelists exactly one binary: this repo's ``.pixi/envs/realsense/bin/python``.
Note that binary is user-writable, so this is effectively "run python as root without
a password" for this user -- fine for a personal dev machine, not for shared ones.
"""

from __future__ import annotations

import dataclasses
import getpass
import pathlib
import subprocess
import tempfile

import tyro

SUDOERS_PATH = "/etc/sudoers.d/so100-realsense"


@dataclasses.dataclass
class Config:
    remove: bool = False
    """Uninstall the sudoers rule instead of installing it."""


def main(config: Config) -> None:
    if config.remove:
        subprocess.run(["sudo", "rm", "-f", SUDOERS_PATH], check=True)
        print(f"removed {SUDOERS_PATH}")
        return
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    env_python = repo_root / ".pixi" / "envs" / "realsense" / "bin" / "python"
    if not env_python.exists():
        raise SystemExit(f"{env_python} does not exist -- run `pixi install -e realsense` first")

    line = f"{getpass.getuser()} ALL=(root) NOPASSWD: {env_python}\n"
    print(f"installing {SUDOERS_PATH}:\n    {line}")

    with tempfile.NamedTemporaryFile("w", suffix=".sudoers", delete=False) as handle:
        handle.write(line)
        tmp = pathlib.Path(handle.name)
    try:
        # Validate BEFORE installing: a malformed file in sudoers.d can break sudo itself.
        subprocess.run(["sudo", "visudo", "-c", "-f", str(tmp)], check=True)
        subprocess.run(["sudo", "install", "-o", "root", "-g", "wheel", "-m", "0440", str(tmp), SUDOERS_PATH], check=True)
    finally:
        tmp.unlink()

    check = subprocess.run(
        ["sudo", "-n", str(env_python), "-c", "print('passwordless sudo works')"],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        raise SystemExit(f"rule installed but verification failed: {check.stderr.strip()}")
    print(check.stdout.strip())
    print("done -- `pixi run -e realsense realsense-debug-sudo` will no longer prompt")


if __name__ == "__main__":
    main(tyro.cli(Config))
