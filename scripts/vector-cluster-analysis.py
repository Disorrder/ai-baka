#!/usr/bin/env python3
import hashlib
import json
import math
import sys
from itertools import combinations
from pathlib import Path

import numpy as np


K_VALUES = (2, 3, 4, 6, 8, 12, 16, 24)
SEEDS = (11, 29, 47, 83, 101)


def normalize(rows):
    norms = np.linalg.norm(rows, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError("zero-length vector")
    return rows / norms, norms[:, 0]


def random_projection(rows, dimensions, seed):
    rng = np.random.default_rng(seed)
    projection = rng.standard_normal((rows.shape[1], dimensions), dtype=np.float32)
    projection /= math.sqrt(dimensions)
    return normalize(rows @ projection)[0]


def spherical_kmeans(rows, clusters, seed, max_iterations=40):
    rng = np.random.default_rng(seed)
    center_indices = [int(rng.integers(rows.shape[0]))]
    closest_distance = np.maximum(1.0 - rows @ rows[center_indices[0]], 0.0)
    for _ in range(1, clusters):
        total = float(closest_distance.sum())
        next_index = int(rng.integers(rows.shape[0])) if total == 0 else int(
            rng.choice(rows.shape[0], p=closest_distance / total)
        )
        center_indices.append(next_index)
        closest_distance = np.minimum(
            closest_distance,
            np.maximum(1.0 - rows @ rows[next_index], 0.0),
        )
    centers = rows[center_indices].copy()
    labels = np.full(rows.shape[0], -1, dtype=np.int32)
    for iteration in range(1, max_iterations + 1):
        similarities = rows @ centers.T
        next_labels = similarities.argmax(axis=1).astype(np.int32)
        if np.array_equal(labels, next_labels):
            break
        labels = next_labels
        next_centers = np.zeros_like(centers)
        assigned = similarities[np.arange(rows.shape[0]), labels]
        for cluster in range(clusters):
            members = rows[labels == cluster]
            if members.shape[0] == 0:
                next_centers[cluster] = rows[int(np.argmin(assigned))]
            else:
                next_centers[cluster] = members.mean(axis=0)
        centers = normalize(next_centers)[0]
    assigned = np.sum(rows * centers[labels], axis=1)
    loss = float(np.mean(1.0 - assigned))
    return labels, centers, loss, iteration


def adjusted_rand(left, right):
    left_values, left_inverse = np.unique(left, return_inverse=True)
    right_values, right_inverse = np.unique(right, return_inverse=True)
    contingency = np.zeros((left_values.size, right_values.size), dtype=np.int64)
    np.add.at(contingency, (left_inverse, right_inverse), 1)
    choose2 = lambda values: values * (values - 1) // 2
    sum_cells = choose2(contingency).sum()
    sum_left = choose2(contingency.sum(axis=1)).sum()
    sum_right = choose2(contingency.sum(axis=0)).sum()
    total = choose2(np.array([left.size], dtype=np.int64))[0]
    expected = (sum_left * sum_right / total) if total else 0.0
    maximum = 0.5 * (sum_left + sum_right)
    return 0.0 if maximum == expected else float((sum_cells - expected) / (maximum - expected))


def normalized_mutual_information(left, right):
    _, left_inverse = np.unique(left, return_inverse=True)
    _, right_inverse = np.unique(right, return_inverse=True)
    contingency = np.zeros((left_inverse.max() + 1, right_inverse.max() + 1), dtype=np.float64)
    np.add.at(contingency, (left_inverse, right_inverse), 1.0)
    probability = contingency / contingency.sum()
    left_probability = probability.sum(axis=1)
    right_probability = probability.sum(axis=0)
    expected = left_probability[:, None] * right_probability[None, :]
    mask = probability > 0
    mutual_information = float(np.sum(probability[mask] * np.log(probability[mask] / expected[mask])))
    left_entropy = float(-np.sum(left_probability[left_probability > 0] * np.log(left_probability[left_probability > 0])))
    right_entropy = float(-np.sum(right_probability[right_probability > 0] * np.log(right_probability[right_probability > 0])))
    denominator = math.sqrt(left_entropy * right_entropy)
    return 0.0 if denominator == 0 else mutual_information / denominator


def cosine_silhouette(similarity, labels):
    clusters = np.unique(labels)
    count = labels.size
    own_distance = np.zeros(count, dtype=np.float64)
    other_distance = np.full(count, np.inf, dtype=np.float64)
    for cluster in clusters:
        members = labels == cluster
        size = int(members.sum())
        distance_to_cluster = 1.0 - similarity[:, members].mean(axis=1)
        if size > 1:
            own_distance[members] = (
                (1.0 - similarity[np.ix_(members, members)]).sum(axis=1) / (size - 1)
            )
        else:
            own_distance[members] = 0.0
        other_distance[~members] = np.minimum(other_distance[~members], distance_to_cluster[~members])
    denominator = np.maximum(own_distance, other_distance)
    scores = np.divide(
        other_distance - own_distance,
        denominator,
        out=np.zeros_like(denominator),
        where=denominator > 0,
    )
    scores[~np.isfinite(scores)] = 0.0
    return float(scores.mean()), np.quantile(scores, (0.05, 0.5, 0.95)).tolist()


def nearest_neighbor_metrics(rows, metadata, limit=1500):
    sample_rows = rows[: min(limit, rows.shape[0])]
    sample_metadata = metadata[: sample_rows.shape[0]]
    similarity = np.clip(sample_rows @ sample_rows.T, -1.0, 1.0)
    np.fill_diagonal(similarity, -np.inf)
    neighbor_indices = np.argpartition(similarity, -10, axis=1)[:, -10:]
    neighbor_values = np.take_along_axis(similarity, neighbor_indices, axis=1)
    order = np.argsort(neighbor_values, axis=1)[:, ::-1]
    neighbor_indices = np.take_along_axis(neighbor_indices, order, axis=1)
    neighbor_values = np.take_along_axis(neighbor_values, order, axis=1)
    harness = np.array([row["harness"] for row in sample_metadata])
    document_type = np.array([row["documentType"] for row in sample_metadata])
    dialogue = np.array([row["dialogueId"] for row in sample_metadata])
    same_harness = float(np.mean(harness[neighbor_indices] == harness[:, None]))
    same_type = float(np.mean(document_type[neighbor_indices] == document_type[:, None]))
    same_dialogue = float(np.mean(dialogue[neighbor_indices] == dialogue[:, None]))
    harness_baseline = float(sum((np.mean(harness == value) ** 2) for value in np.unique(harness)))
    type_baseline = float(sum((np.mean(document_type == value) ** 2) for value in np.unique(document_type)))
    rng = np.random.default_rng(20260729)
    pair_left = rng.integers(0, sample_rows.shape[0], 100_000)
    pair_right = rng.integers(0, sample_rows.shape[0], 100_000)
    different = pair_left != pair_right
    random_similarity = np.sum(sample_rows[pair_left[different]] * sample_rows[pair_right[different]], axis=1)
    return {
        "rows": int(sample_rows.shape[0]),
        "top1Cosine": percentile_summary(neighbor_values[:, 0]),
        "top10Cosine": percentile_summary(neighbor_values.reshape(-1)),
        "randomPairCosine": percentile_summary(random_similarity),
        "sameHarnessAt10": same_harness,
        "sameHarnessRandomBaseline": harness_baseline,
        "sameDocumentTypeAt10": same_type,
        "sameDocumentTypeRandomBaseline": type_baseline,
        "sameDialogueAt10": same_dialogue,
        "nearIdenticalTop1": int(np.sum(neighbor_values[:, 0] >= 0.9999)),
    }


def percentile_summary(values):
    q = np.quantile(values, (0.05, 0.25, 0.5, 0.75, 0.95))
    return {key: float(value) for key, value in zip(("p05", "p25", "p50", "p75", "p95"), q)}


def projection_validation(original, projected, pairs=50_000):
    rng = np.random.default_rng(7001)
    left = rng.integers(0, original.shape[0], pairs)
    right = rng.integers(0, original.shape[0], pairs)
    source = np.sum(original[left] * original[right], axis=1)
    target = np.sum(projected[left] * projected[right], axis=1)
    return {
        "pairs": pairs,
        "pearson": float(np.corrcoef(source, target)[0, 1]),
        "meanAbsoluteError": float(np.mean(np.abs(source - target))),
    }


def randomized_pca(rows, components=16, seed=991):
    centered = rows - rows.mean(axis=0, keepdims=True)
    rng = np.random.default_rng(seed)
    omega = rng.standard_normal((rows.shape[1], components + 8), dtype=np.float32)
    basis, _ = np.linalg.qr(centered @ omega, mode="reduced")
    for _ in range(2):
        feature_basis, _ = np.linalg.qr(centered.T @ basis, mode="reduced")
        basis, _ = np.linalg.qr(centered @ feature_basis, mode="reduced")
    reduced = basis.T @ centered
    left, singular_values, _ = np.linalg.svd(reduced, full_matrices=False)
    coordinates = basis @ left[:, :2] * singular_values[:2]
    total_variance = float(np.sum(centered * centered))
    ratios = (singular_values * singular_values) / total_variance
    return coordinates, ratios[:components]


def cluster_profiles(labels, metadata):
    harness = np.array([row["harness"] for row in metadata])
    document_type = np.array([row["documentType"] for row in metadata])
    profiles = []
    for cluster in np.unique(labels):
        members = labels == cluster
        harness_values, harness_counts = np.unique(harness[members], return_counts=True)
        top = int(np.argmax(harness_counts))
        profiles.append({
            "cluster": int(cluster),
            "rows": int(members.sum()),
            "assistantFinalShare": float(np.mean(document_type[members] == "assistant_final")),
            "topHarness": str(harness_values[top]),
            "topHarnessShare": float(harness_counts[top] / members.sum()),
        })
    return profiles


def run_cluster_grid(projected, similarity):
    one_center = normalize(projected.mean(axis=0, keepdims=True))[0][0]
    one_loss = float(np.mean(1.0 - projected @ one_center))
    grid = []
    best_by_silhouette = None
    labels_by_k = {}
    for clusters in K_VALUES:
        runs = [spherical_kmeans(projected, clusters, seed) for seed in SEEDS]
        best = min(runs, key=lambda item: item[2])
        stability = [adjusted_rand(left[0], right[0]) for left, right in combinations(runs, 2)]
        silhouette, silhouette_quantiles = cosine_silhouette(similarity, best[0])
        sizes = np.bincount(best[0], minlength=clusters)
        row = {
            "k": clusters,
            "silhouette": silhouette,
            "silhouetteP05": float(silhouette_quantiles[0]),
            "silhouetteP50": float(silhouette_quantiles[1]),
            "silhouetteP95": float(silhouette_quantiles[2]),
            "stabilityAriMean": float(np.mean(stability)),
            "stabilityAriMin": float(np.min(stability)),
            "cosineLoss": best[2],
            "lossReductionVsK1": float(1.0 - best[2] / one_loss),
            "smallestCluster": int(sizes.min()),
            "largestCluster": int(sizes.max()),
            "iterations": int(best[3]),
        }
        grid.append(row)
        labels_by_k[clusters] = best[0]
        if best_by_silhouette is None or row["silhouette"] > best_by_silhouette["silhouette"]:
            best_by_silhouette = row
    return grid, labels_by_k[int(best_by_silhouette["k"])], best_by_silhouette


def analyze_structure(normalized, metadata, exact_silhouette=False):
    projected = random_projection(normalized, 256, 6419)
    similarity = np.clip(projected @ projected.T, -1.0, 1.0)
    cluster_grid, best_labels, best = run_cluster_grid(projected, similarity)
    harness = np.array([row["harness"] for row in metadata])
    document_type = np.array([row["documentType"] for row in metadata])
    coordinates, explained = randomized_pca(normalized)
    selected_indices = np.linspace(0, len(metadata) - 1, min(1_000, len(metadata)), dtype=int)
    scatter = [
        {
            "x": float(coordinates[index, 0]),
            "y": float(coordinates[index, 1]),
            "cluster": f"C{int(best_labels[index]) + 1}",
            "documentType": metadata[index]["documentType"],
            "harness": metadata[index]["harness"],
        }
        for index in selected_indices
    ]
    projected_128 = random_projection(normalized, 128, 6419)
    sensitivity_runs = [spherical_kmeans(projected_128, int(best["k"]), seed) for seed in SEEDS[:3]]
    sensitivity_best = min(sensitivity_runs, key=lambda item: item[2])
    sensitivity_similarity = np.clip(projected_128 @ projected_128.T, -1.0, 1.0)
    sensitivity_silhouette = cosine_silhouette(sensitivity_similarity, sensitivity_best[0])[0]
    result = {
        "rows": len(metadata),
        "projectionValidation": projection_validation(normalized, projected),
        "clusterGrid": cluster_grid,
        "bestKBySilhouette": int(best["k"]),
        "bestSilhouette": float(best["silhouette"]),
        "bestStabilityAriMean": float(best["stabilityAriMean"]),
        "labelAlignment": {
            "documentTypeNmi": normalized_mutual_information(best_labels, document_type),
            "harnessNmi": normalized_mutual_information(best_labels, harness),
        },
        "profiles": cluster_profiles(best_labels, metadata),
        "neighborhood": nearest_neighbor_metrics(normalized, metadata),
        "randomizedPca": {
            "components": int(explained.size),
            "explainedVarianceFirst2": float(explained[:2].sum()),
            "explainedVarianceFirst10": float(explained[:10].sum()),
        },
        "projection128Sensitivity": {
            "k": int(best["k"]),
            "silhouette": float(sensitivity_silhouette),
            "stabilityAriMean": float(np.mean([
                adjusted_rand(left[0], right[0]) for left, right in combinations(sensitivity_runs, 2)
            ])),
        },
        "scatter": scatter,
    }
    if exact_silhouette:
        original_similarity = np.clip(normalized @ normalized.T, -1.0, 1.0)
        exact_value, exact_quantiles = cosine_silhouette(original_similarity, best_labels)
        result["originalSpaceSilhouette"] = exact_value
        result["originalSpaceSilhouetteP05"] = float(exact_quantiles[0])
        result["originalSpaceSilhouetteP50"] = float(exact_quantiles[1])
        result["originalSpaceSilhouetteP95"] = float(exact_quantiles[2])
    return result


def analyze_sample(private_dir, sample_name):
    metadata = json.loads((private_dir / f"{sample_name}.metadata.json").read_text())
    rows = np.fromfile(private_dir / f"{sample_name}.f32", dtype="<f4").reshape(len(metadata), -1)
    normalized, norms = normalize(rows)
    hash_groups = {}
    for index, row in enumerate(rows):
        digest = hashlib.sha256(row.tobytes()).digest()
        hash_groups.setdefault(digest, []).append(index)
    unique_indices = np.array([indices[0] for indices in hash_groups.values()], dtype=np.int64)
    duplicate_groups = [indices for indices in hash_groups.values() if len(indices) > 1]
    input_groups = {}
    for index, row in enumerate(metadata):
        input_groups.setdefault(row["inputSha256"], []).append(index)
    duplicate_input_groups = [indices for indices in input_groups.values() if len(indices) > 1]
    vector_groups_with_multiple_inputs = sum(
        len({metadata[index]["inputSha256"] for index in indices}) > 1
        for indices in duplicate_groups
    )
    input_groups_with_multiple_vectors = sum(
        len({hashlib.sha256(rows[index].tobytes()).digest() for index in indices}) > 1
        for indices in duplicate_input_groups
    )
    return {
        "name": sample_name,
        "rows": len(metadata),
        "dimensions": rows.shape[1],
        "dataQuality": {
            "uniqueVectorRows": len(hash_groups),
            "duplicateVectorRows": len(metadata) - len(hash_groups),
            "duplicateGroups": len(duplicate_groups),
            "rowsInDuplicateGroups": int(sum(len(indices) for indices in duplicate_groups)),
            "largestDuplicateGroup": int(max((len(indices) for indices in duplicate_groups), default=1)),
            "uniqueInputHashes": len(input_groups),
            "duplicateInputRows": len(metadata) - len(input_groups),
            "duplicateInputGroups": len(duplicate_input_groups),
            "largestDuplicateInputGroup": int(max((len(indices) for indices in duplicate_input_groups), default=1)),
            "sameVectorMultipleInputHashGroups": int(vector_groups_with_multiple_inputs),
            "sameInputMultipleVectorGroups": int(input_groups_with_multiple_vectors),
            "norm": percentile_summary(norms),
            "missingHarness": int(sum(not row["harness"] for row in metadata)),
            "missingDocumentType": int(sum(not row["documentType"] for row in metadata)),
        },
        "rawStructure": analyze_structure(normalized, metadata),
        "deduplicatedStructure": analyze_structure(
            normalized[unique_indices],
            [metadata[index] for index in unique_indices],
            exact_silhouette=True,
        ),
    }


def random_baseline(rows, dimensions=256):
    rng = np.random.default_rng(123456)
    random_rows = normalize(rng.standard_normal((rows, dimensions), dtype=np.float32))[0]
    similarity = np.clip(random_rows @ random_rows.T, -1.0, 1.0)
    output = []
    for clusters in (2, 4, 8, 16):
        runs = [spherical_kmeans(random_rows, clusters, seed) for seed in SEEDS[:3]]
        best = min(runs, key=lambda item: item[2])
        output.append({
            "k": clusters,
            "silhouette": cosine_silhouette(similarity, best[0])[0],
            "stabilityAriMean": float(np.mean([
                adjusted_rand(left[0], right[0]) for left, right in combinations(runs, 2)
            ])),
        })
    return output


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: vector-cluster-analysis.py <private-input-dir> <aggregate-output.json>")
    private_dir = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    manifest = json.loads((private_dir / "manifest.json").read_text())
    population = analyze_sample(private_dir, "population")
    balanced = analyze_sample(private_dir, "balanced")
    result = {
        "formatVersion": 1,
        "generatedAt": manifest["generatedAt"],
        "status": "ready",
        "source": manifest["source"],
        "method": {
            "populationSample": "First 3,000 deterministic vector ids; ids are SHA-derived and preserve corpus mix approximately.",
            "balancedSample": "Up to 150 vectors per harness × document_type stratum; small strata remain complete.",
            "distance": "Cosine on L2-normalized vectors; spherical k-means after fixed 256D Gaussian random projection.",
            "clusterStrengthHeuristic": "silhouette <0.25 weak/overlapping; 0.25–0.50 moderate; >0.50 strong.",
            "stability": "Mean adjusted Rand index across five k-means seeds.",
            "privacy": "No text, document ids, dialogue ids, or raw vectors are present in this aggregate.",
        },
        "population": population,
        "balanced": balanced,
        "randomBaseline": random_baseline(1_500),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({
        "output": str(output_path),
        "population": {
            "rows": population["rows"],
            "dataQuality": population["dataQuality"],
            "raw": {key: population["rawStructure"][key] for key in (
                "bestKBySilhouette", "bestSilhouette", "bestStabilityAriMean", "labelAlignment",
            )},
            "deduplicated": {key: population["deduplicatedStructure"][key] for key in (
                "rows", "bestKBySilhouette", "bestSilhouette", "bestStabilityAriMean", "labelAlignment",
            )},
        },
        "balanced": {
            "rows": balanced["rows"],
            "dataQuality": balanced["dataQuality"],
            "raw": {key: balanced["rawStructure"][key] for key in (
                "bestKBySilhouette", "bestSilhouette", "bestStabilityAriMean", "labelAlignment",
            )},
            "deduplicated": {key: balanced["deduplicatedStructure"][key] for key in (
                "rows", "bestKBySilhouette", "bestSilhouette", "bestStabilityAriMean", "labelAlignment",
            )},
        },
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
