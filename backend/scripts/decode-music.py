"""Decode the first audio stream from an MP4 to 16 kHz mono PCM16 on stdout."""

from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: decode-music.py <mp4-file>", file=sys.stderr)
        return 2
    try:
        import av

        with av.open(sys.argv[1], mode="r") as container:
            stream = next(iter(container.streams.audio), None)
            if stream is None:
                raise ValueError("file has no audio stream")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            output = sys.stdout.buffer
            for frame in container.decode(stream):
                for converted in resampler.resample(frame):
                    output.write(converted.to_ndarray().tobytes())
            for converted in resampler.resample(None):
                output.write(converted.to_ndarray().tobytes())
            output.flush()
        return 0
    except Exception as exc:  # Keep diagnostics off the PCM output stream.
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
