import tyro

from so100_hackathon.apis.log_arms import LogArmsConfig, main

if __name__ == "__main__":
    main(tyro.cli(LogArmsConfig))
