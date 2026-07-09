"""Re-export an existing SO-100 calibration in LeRobot's on-disk format.

``calibrate-so100`` already dual-writes this file at calibration time; this tool
covers arms calibrated before dual-write existed (or a wiped HF cache) without
redoing the two-step calibration procedure. The output lands where every
LeRobot-ecosystem tool looks for it — including the newt-starter-so101
deployment client — so the arm is driven with EXACTLY the calibration your
datasets were recorded with, and "42 deg" means the same physical pose at
train time and at inference time.

Why the arm must be plugged in: our ``calibrations/<usb_id>.json`` stores
``homing_offset = 0`` because the real offsets live in the servos' EEPROM
(written during calibration). LeRobot's connect-time ``is_calibrated`` check
compares its JSON against those registers — and on mismatch writes the JSON's
values back INTO the servos, which would destroy the calibration. So the
exported file must mirror EEPROM exactly, and the only place to read that from
is the arm itself.

    pixi run export-calibration -- follower
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import tyro

from so100_hackathon.calibration import DEFAULT_MOTOR_NAMES, lerobot_calibration_path, load_arm_kind, load_arm_ranges, save_lerobot_calibration
from so100_hackathon.feetech import FeetechBus, detect_arm_ports, usb_id_from_port


@dataclass
class ExportCalibrationConfig:
    kind: tyro.conf.Positional[Literal["leader", "follower"]]
    """Which arm's calibration to export (the newt starter only needs the follower)."""
    port: str | None = None
    """Serial port of the arm. Default: the single plugged-in arm whose calibration matches ``kind``."""
    calibration_dir: Path = Path("calibrations")


def main(config: ExportCalibrationConfig) -> None:
    ports = (config.port,) if config.port else detect_arm_ports()
    matches = [
        (port, usb_id)
        for port in ports
        if load_arm_kind(config.calibration_dir / f"{usb_id_from_port(port)}.json") == config.kind
        for usb_id in [usb_id_from_port(port)]
    ]
    if not matches:
        raise SystemExit(
            f"no plugged-in arm has a {config.kind} calibration in {config.calibration_dir}/ — "
            f"run `pixi run calibrate-so100 {config.kind}` first (it dual-writes the LeRobot file automatically)"
        )
    if len(matches) > 1:
        raise SystemExit(f"several {config.kind}-calibrated arms plugged in ({', '.join(p for p, _ in matches)}) — pick one with --port")
    port, usb_id = matches[0]

    our_path = config.calibration_dir / f"{usb_id}.json"
    ranges = load_arm_ranges(our_path)
    if ranges is None:
        raise SystemExit(f"{our_path} has no range-of-motion sweep (too old?) — re-run `pixi run calibrate-so100 {config.kind}`")
    range_min, range_max = ranges

    # The homing offsets are servo-side (EEPROM), not in our JSON — read them off the arm.
    bus = FeetechBus(port)
    try:
        homing_offsets = [bus.read_homing_offset(motor_id) for motor_id in bus.motor_ids]
        motor_ids = bus.motor_ids
    finally:
        bus.close()

    out_path = lerobot_calibration_path(config.kind, usb_id)
    save_lerobot_calibration(out_path, DEFAULT_MOTOR_NAMES, motor_ids, homing_offsets, range_min, range_max)
    print(f"wrote {out_path}")
    print(f"LeRobot-ecosystem tools (incl. newt-starter-so101) pick it up with --robot.id={usb_id} — no lerobot-calibrate sweep needed.")
