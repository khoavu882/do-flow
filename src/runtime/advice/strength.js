'use strict';

function strengthOf(answer, bands) {
  const type = answer?.type;
  const thresholds = bands?.[type] || bands;
  const probabilities = answer?.probabilities;
  if (!thresholds || !probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    return { word: 'leaning', between: null };
  }

  if (type === 'choice') {
    const ordered = Object.entries(probabilities)
      .filter(([, probability]) => typeof probability === 'number' && Number.isFinite(probability))
      .sort((left, right) => right[1] - left[1]);
    if (!ordered.length) return { word: 'leaning', between: null };
    if (ordered[0][1] >= thresholds.clearAt) return { word: 'clear', between: null };
    if (ordered.length > 1) {
      const gap = ordered[0][1] - ordered[1][1];
      const boundaryNoise = Number.EPSILON * Math.max(1, Math.abs(ordered[0][1]), Math.abs(ordered[1][1])) * 4;
      if (gap < thresholds.splitWithin && thresholds.splitWithin - gap > boundaryNoise) {
        return { word: 'split', between: [ordered[0][0], ordered[1][0]] };
      }
    }
    return { word: 'leaning', between: null };
  }

  if (type === 'score') {
    const choice = bands?.choice;
    const criteria = answer.criteria;
    if (!choice || !Array.isArray(criteria)) return { word: 'leaning', between: null };
    const ordered = criteria.map((criterion, index) => [criterion, probabilities[String(index)]])
      .filter(([, probability]) => typeof probability === 'number' && Number.isFinite(probability))
      .sort((left, right) => right[1] - left[1]);
    if (!ordered.length) return { word: 'leaning', between: null };
    if (ordered[0][1] >= choice.clearAt) return { word: 'clear', between: null };
    if (ordered.length > 1) {
      const gap = ordered[0][1] - ordered[1][1];
      const noise = Number.EPSILON * Math.max(1, Math.abs(ordered[0][1]), Math.abs(ordered[1][1])) * 4;
      if (gap < choice.splitWithin && choice.splitWithin - gap > noise) {
        return { word: 'split', between: [ordered[0][0], ordered[1][0]] };
      }
    }
    return { word: 'leaning', between: null };
  }

  if (type === 'yesno') {
    const probability = probabilities.yes;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) return { word: 'leaning', between: null };
    if (probability >= thresholds.clearAbove || probability <= thresholds.clearBelow) return { word: 'clear', between: null };
    if (probability >= thresholds.splitFrom && probability <= thresholds.splitTo) {
      return { word: 'split', between: ['yes', 'no'] };
    }
  }
  return { word: 'leaning', between: null };
}

function strengthWords(strength) {
  if (strength?.word === 'split' && Array.isArray(strength.between) && strength.between.length === 2) {
    return `split between ${strength.between[0]} and ${strength.between[1]}`;
  }
  return strength?.word === 'clear' ? 'clear' : 'leaning';
}

module.exports = { strengthOf, strengthWords };
