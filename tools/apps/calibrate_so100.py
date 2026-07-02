import tyro

from so100_hackathon.apis.calibrate import CalibrateConfig, main

if __name__ == "__main__":
    main(tyro.cli(CalibrateConfig))
