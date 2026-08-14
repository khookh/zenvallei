"""Command-line entry point for local official data preparation."""

from __future__ import annotations

import argparse
from pathlib import Path

from .dataset_registry import (
    DATASET_SPECS,
    dataset_ids,
    dataset_spec,
    format_dataset_description,
    format_dataset_list,
)
from .pipeline import update_index


def parse_source(values: list[str]) -> dict[int, Path]:
    sources = {}
    for value in values:
        if "=" not in value:
            raise argparse.ArgumentTypeError("--source must use YEAR=path.")
        year, path = value.split("=", 1)
        source = Path(path).expanduser()
        if not year.isdigit() or not source.exists():
            raise argparse.ArgumentTypeError(f"Invalid source {value!r}.")
        sources[int(year)] = source
    return sources


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare local Greenwave raster layers.")
    parser.add_argument("--dataset", choices=("all", *dataset_ids()), default="all")
    parser.add_argument("--source", action="append", default=[], metavar="YEAR=PATH")
    parser.add_argument("--list", action="store_true", help="List preparation datasets and exit.")
    parser.add_argument("--describe", choices=dataset_ids(), metavar="DATASET",
                        help="Describe one dataset contract and exit.")
    arguments = parser.parse_args(argv)
    if arguments.list or arguments.describe:
        if arguments.source:
            parser.error("--list and --describe cannot be combined with --source.")
        print(format_dataset_list() if arguments.list else
              format_dataset_description(dataset_spec(arguments.describe)))
        return

    sources = parse_source(arguments.source)
    if arguments.dataset == "all" and sources:
        parser.error("Use --source with one explicit --dataset so the year cannot be assigned to the wrong product.")
    specs = DATASET_SPECS if arguments.dataset == "all" else (dataset_spec(arguments.dataset),)
    for spec in specs:
        print(f"Preparing {spec.dataset_id}...", flush=True)
        try:
            spec.prepare(sources)
        except ValueError as error:
            parser.error(str(error))
        update_index()
    update_index()
    print("Local manifests and PMTiles are ready below .cache/local-layers.")


if __name__ == "__main__":
    main()
