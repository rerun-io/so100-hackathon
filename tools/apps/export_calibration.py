import tyro

from so100_hackathon.apis.export_calibration import ExportCalibrationConfig, main

if __name__ == "__main__":
    main(tyro.cli(ExportCalibrationConfig))
