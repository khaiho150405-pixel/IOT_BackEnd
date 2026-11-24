#!/usr/bin/env python3
"""Download VinAI PhoWhisper (base by default, or --size small) and convert it for faster-whisper (CTranslate2 int8).

PhoWhisper-base is the Vietnamese speech model used by the local voice bridge
(measured ~4% word errors vs ~30% for multilingual Whisper base on Vietnamese
commands). The result is ~76 MB and is not committed to git.

Usage (from the repository root):
    python scripts/setup-phowhisper.py                    # -> models/phowhisper-base-ct2
    python scripts/setup-phowhisper.py --output D:/models/phowhisper-base-ct2
    python scripts/setup-phowhisper.py --source <already downloaded vinai/PhoWhisper-base folder>
    python scripts/setup-phowhisper.py --size small --output E:/AIoT/models/phowhisper-small-ct2
        (PhoWhisper-small: ~970 MB download, ~250 MB converted; best run on a GPU, LOCAL_ASR_DEVICE=cuda)

Requires: backend/requirements-model-convert.txt (torch CPU, transformers,
huggingface_hub, ctranslate2). Then set in backend/.env:
    LOCAL_WHISPER_MODEL=../models/phowhisper-base-ct2
"""

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

SIZES = {"base": "~290 MB", "small": "~970 MB", "medium": "~3 GB"}  # vinai/PhoWhisper-<size>, BSD-3-Clause
REQUIRED = ("config.json", "model.bin", "tokenizer.json")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--size", choices=sorted(SIZES), default="base")
    parser.add_argument("--output", help="default: models/phowhisper-<size>-ct2")
    parser.add_argument("--source", help="existing download of vinai/PhoWhisper-base (skips the download)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing output folder")
    args = parser.parse_args()
    repo = f"vinai/PhoWhisper-{args.size}"
    args.output = args.output or str(root / "models" / f"phowhisper-{args.size}-ct2")

    output = Path(args.output).resolve()
    if output.exists() and all((output / name).is_file() for name in REQUIRED) and not args.force:
        print(f"Already converted: {output}")
        return 0
    try:
        import ctranslate2  # noqa: F401
        import transformers  # noqa: F401
        import torch  # noqa: F401
    except ImportError as error:
        print(f"Missing package ({error.name}). Install backend/requirements-model-convert.txt first.", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="phowhisper-") as temporary:
        source = Path(args.source).resolve() if args.source else None
        if source is None:
            from huggingface_hub import snapshot_download

            print(f"Downloading {repo} ({SIZES[args.size]})...", flush=True)
            source = Path(snapshot_download(repo, local_dir=temporary,
                                            allow_patterns=["*.json", "*.txt", "pytorch_model.bin", "*.safetensors"]))
        if not (source / "config.json").is_file():
            print(f"Not a PhoWhisper download: {source}", file=sys.stderr)
            return 1

        from ctranslate2.converters import TransformersConverter

        if output.exists():
            shutil.rmtree(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        print(f"Converting to CTranslate2 int8 -> {output}", flush=True)
        TransformersConverter(str(source), copy_files=["tokenizer.json", "preprocessor_config.json"]).convert(
            str(output), quantization="int8", force=True)

    missing = [name for name in REQUIRED if not (output / name).is_file()]
    if missing:
        print(f"Conversion incomplete, missing {missing}", file=sys.stderr)
        return 1
    size = sum(f.stat().st_size for f in output.iterdir()) / 1e6
    print(f"Done ({size:.0f} MB). Set LOCAL_WHISPER_MODEL in backend/.env to this folder.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
