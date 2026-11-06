"""Launched by test_main: runs main.run with a router that print()s like a noisy library."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class NoisyRouter:
    async def start(self):
        print("stub started")

    async def stop(self):
        print("stub stopped")

    async def handle(self, op, args):
        print("noise from a library")
        print("café in a log line")
        return {"op": op}


main.run(NoisyRouter)
