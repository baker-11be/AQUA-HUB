(function () {
  function normalizeFlag(flag) {
    if (typeof flag === 'string') {
      return { category: 'inconsistency', message: flag };
    }

    return {
      category: flag?.category || 'inconsistency',
      message: flag?.message || 'Anomaly detected'
    };
  }

  function categoryLabel(category) {
    const map = {
      duplicate: 'Duplicate',
      completion_time: 'Completion time',
      missing_value: 'Missing value',
      inconsistency: 'Inconsistency'
    };

    return map[category] || 'Inconsistency';
  }

  function summarizeAnomalyDetails(answers) {
    const categoryCounts = {};
    const details = [];
    let totalFlaggedAnswers = 0;
    let totalFlags = 0;

    for (const answer of answers || []) {
      const flags = Array.isArray(answer?.flags) ? answer.flags : [];
      if (!flags.length) continue;

      totalFlaggedAnswers += 1;
      totalFlags += flags.length;

      for (const flag of flags) {
        const normalized = normalizeFlag(flag);
        categoryCounts[normalized.category] = (categoryCounts[normalized.category] || 0) + 1;

        details.push({
          interviewId: answer.interviewId || answer.interview_id || 'N/A',
          respondent: answer.respondent || 'Unknown respondent',
          enumerator: answer.enumerator || 'Unknown enumerator',
          question: answer.id || 'Unknown question',
          response: answer.response || '—',
          category: normalized.category,
          label: categoryLabel(normalized.category),
          message: normalized.message,
          duration: answer.response_time_seconds ?? answer.question_duration_seconds ?? 0,
          status: answer.status || 'flagged'
        });
      }
    }

    const sortedCategories = Object.entries(categoryCounts);
    const mostCommonCategory = sortedCategories.length ? sortedCategories.reduce((winner, current) => (current[1] > winner[1] ? current : winner), sortedCategories[0])[0] : null;

    return {
      totalFlaggedAnswers,
      totalFlags,
      categoryCounts,
      mostCommonCategory,
      details,
      categoryLabels: Object.fromEntries(sortedCategories)
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { summarizeAnomalyDetails, categoryLabel };
  }

  if (typeof window !== 'undefined') {
    window.summarizeAnomalyDetails = summarizeAnomalyDetails;
    window.categoryLabel = categoryLabel;
  }
})();
