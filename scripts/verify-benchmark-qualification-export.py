"""Reconcile a downloaded Wallie M08 qualification export."""

import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sys

STATUSES = {
    "excluded": "excluded",
    "pending": "pending",
    "running": "running",
    "succeeded": "succeeded",
    "failed": "failed",
    "timed_out": "timedOut",
    "canceled": "canceled",
    "unavailable": "unavailable",
}
TERMINAL = set(STATUSES) - {"excluded", "pending", "running"}
BUCKETS = {
    "measuredUsd": Decimal,
    "estimatedUsd": Decimal,
    "knownUsd": Decimal,
    "reservedUsd": Decimal,
    "unavailableHoldUsd": Decimal,
    "measuredAttemptCount": int,
    "estimatedAttemptCount": int,
    "unavailableAttemptCount": int,
    "pendingAttemptCount": int,
    "neverStartedAttemptCount": int,
}


def expect(actual, expected, label):
    if actual != expected:
        raise ValueError(f"{label}. Expected {expected!r}, got {actual!r}.")


def read_parts(directory, manifest, kind, descriptor_key, filename, row_key, id_key, field):
    rows = []
    for ordinal, entry in enumerate(manifest[descriptor_key], start=1):
        expect(entry["ordinal"], ordinal, f"{kind} part position")
        path = directory / f"benchmark-{manifest['exportId']}-{filename}-{ordinal}.json"
        body = path.read_bytes()
        expect(len(body), entry["sizeBytes"], f"{path.name} byte count")
        expect(hashlib.sha256(body).hexdigest(), entry["sha256"], f"{path.name} digest")
        part = json.loads(body)
        expect(part["kind"], kind, f"{path.name} kind")
        expect(part["schemaVersion"], manifest["schemaVersion"], f"{path.name} schema version")
        expect(part["exportId"], manifest["exportId"], f"{path.name} export ID")
        expect(part["ordinal"], ordinal, f"{path.name} ordinal")
        current = part[row_key]
        expect(len(current), entry[f"{field.lower().removesuffix('id').removesuffix('key')}Count"],
               f"{path.name} row count")
        expect(current[0][id_key], entry[f"first{field}"], f"{path.name} first row")
        expect(current[-1][id_key], entry[f"last{field}"], f"{path.name} last row")
        rows.extend(current)
    return rows


def reconcile(label, report, trials):
    expected_counts = {bucket: 0 for bucket in STATUSES.values()}
    for trial in trials:
        expected_counts[STATUSES[trial["status"]]] += 1
    expected_counts.update(
        planned=len(trials),
        eligible=sum(row["eligibility"] == "eligible" for row in trials),
        admitted=sum(row["admitted"] for row in trials),
        started=sum(row["started"] for row in trials),
        terminal=sum(row["status"] in TERMINAL for row in trials),
    )
    expect(report["counts"], expected_counts, f"{label} counts")
    for axis in ("execution", "evaluation", "combined"):
        for key, numeric in BUCKETS.items():
            total = sum(numeric(row["spend"][axis][key]) for row in trials)
            expect(numeric(report["spend"][axis][key]), total, f"{label} {axis} {key}")
    expect(
        report["spend"]["costUnavailableTrialCount"],
        sum(row["spend"]["costUnavailableTrialCount"] for row in trials),
        f"{label} distinct trials with unavailable spend",
    )


def check_matrix(trials, candidates, summary, expected_trials):
    expect(len(trials), expected_trials, "matrix row count")
    expect(len(candidates), summary["candidateCount"], "configuration row count")
    by_candidate = {candidate["candidateKey"]: candidate for candidate in candidates}
    expect(len(by_candidate), len(candidates), "unique candidate count")
    by_cell = Counter()
    seeds = {}
    revisions = {}
    for row in trials:
        candidate = by_candidate[row["candidateKey"]]
        expect(row["candidatePosition"], candidate["position"], "candidate position")
        expect(row["plannedHarness"], candidate["plannedHarness"], "planned harness")
        expect(row["plannedModel"], candidate["plannedModel"], "planned model")
        task = row["task"]
        revision = revisions.setdefault(task["id"], task["revisionId"])
        expect(task["revisionId"], revision, "frozen task revision")
        expect(row["status"] == "excluded", row["eligibility"] != "eligible", "trial exclusion")
        seed_key = (task["id"], row["repetition"])
        expect(row["seed"], seeds.setdefault(seed_key, row["seed"]), "paired repetition seed")
        by_cell[(task["id"], candidate["candidateKey"], row["repetition"])] += 1
    expect(
        by_cell,
        Counter((task, key, repetition) for task in revisions for key in by_candidate
                for repetition in range(1, summary["repetitions"] + 1)),
        "frozen task × candidate × repetition identities",
    )
    reconcile("Experiment", summary, trials)
    for key, candidate in by_candidate.items():
        reconcile(f"Candidate {key}", candidate, [row for row in trials if row["candidateKey"] == key])
        for quality in candidate["quality"]:
            outcomes = [
                score["status"]
                for row in trials if row["candidateKey"] == key
                for score in row["scores"]
                if score["scorerRevisionId"] == quality["scorerRevisionId"]
            ]
            expect(len(outcomes), quality["denominator"], "scorer denominator")
            for status in ("pending", "pass", "fail", "inconclusive", "skipped", "error", "unavailable"):
                expect(quality[status], outcomes.count(status), f"scorer {status}")


def main():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("manifest", type=Path, help="Manifest saved beside every downloaded part")
    arguments.add_argument("--expected-trials", type=int, required=True)
    arguments.add_argument("--original-snapshot", type=Path, help="Comparison JSON saved before editing")
    options = arguments.parse_args()
    manifest = json.loads(options.manifest.read_bytes())
    directory = options.manifest.parent
    trials = read_parts(directory, manifest, "trials", "pages", "part", "trialRows", "trialId", "TrialId")
    candidates = read_parts(directory, manifest, "candidates", "candidatePages", "candidate-part",
                            "candidates", "candidateKey", "CandidateKey")
    ids = [row["trialId"] for row in trials]
    expect(ids, manifest["trialIds"], "frozen trial IDs in export order")
    expect(len(set(ids)), len(ids), "unique trial count")
    summary = manifest["summary"]
    expect(summary["experimentId"], manifest["experimentId"], "experiment ID")
    check_matrix(trials, candidates, summary, options.expected_trials)
    if options.original_snapshot:
        original = json.loads(options.original_snapshot.read_bytes())
        for key in ("experimentId", "suite", "seed", "repetitions", "policyRevisionId", "policyDigest"):
            expect(summary[key], original[key], f"original comparison {key}")
        expect(ids, [row["trialId"] for row in original["trialRows"]], "original comparison trial IDs")
    print(f"Verified {len(trials)} trial rows, {len(candidates)} configurations, and all exported spend.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, IndexError, OSError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
