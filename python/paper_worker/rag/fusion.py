def reciprocal_rank_fusion(rankings: list[list[str]], constant: int = 60):
    scores = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, 1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (constant + rank)
    return sorted(scores.items(), key=lambda x: (-x[1], x[0]))
