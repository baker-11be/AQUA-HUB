const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeAnomalyDetails } = require('../anomaly_analysis.js');

test('summarizeAnomalyDetails counts categories and evidence across flagged answers', () => {
  const answers = [
    {
      id: 'Q01',
      status: 'flagged',
      respondent: 'Nia',
      interviewId: 'INT-100',
      enumerator: 'ENUM001',
      response: 'Nia',
      response_time_seconds: 210,
      flags: [
        { category: 'duplicate', message: 'Duplicate response found for this respondent' },
        { category: 'completion_time', message: 'Answer recorded unusually fast' }
      ]
    },
    {
      id: 'Q02',
      status: 'flagged',
      respondent: 'Liam',
      interviewId: 'INT-200',
      enumerator: 'ENUM002',
      response: '32',
      response_time_seconds: 60,
      flags: [{ category: 'inconsistency', message: 'Age is outside the expected range' }]
    },
    {
      id: 'Q03',
      status: 'normal',
      respondent: 'Mia',
      interviewId: 'INT-300',
      enumerator: 'ENUM003',
      response: 'Student',
      response_time_seconds: 18,
      flags: []
    }
  ];

  const summary = summarizeAnomalyDetails(answers);

  assert.equal(summary.totalFlaggedAnswers, 2);
  assert.equal(summary.totalFlags, 3);
  assert.deepEqual(summary.categoryCounts, {
    duplicate: 1,
    completion_time: 1,
    inconsistency: 1
  });
  assert.equal(summary.mostCommonCategory, 'duplicate');
  assert.equal(summary.details.length, 3);
});
