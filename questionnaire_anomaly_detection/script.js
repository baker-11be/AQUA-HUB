const questions = [
  {
    id: 'Q01',
    text: 'What is your name?',
    type: 'text',
    key: 'name',
    check: (value) => (value.length >= 2 ? null : 'Enter the respondent’s full name.')
  },
  {
    id: 'Q02',
    text: 'How old are you?',
    type: 'text',
    key: 'age',
    placeholder: 'e.g. 24'
  },
  {
    id: 'Q03',
    text: 'What is your main occupation?',
    type: 'select',
    key: 'occupation',
    options: ['Farming', 'Business', 'Salaried employment', 'Student', 'Other']
  },
  {
    id: 'Q04',
    text: 'What is your marital status?',
    type: 'select',
    key: 'marital',
    options: ['Single', 'Married', 'Divorced', 'Widowed']
  },
  {
    id: 'Q05',
    text: 'Which district do you live in?',
    type: 'text',
    key: 'district',
    check: (value) => (value.length >= 2 ? null : 'Enter a district name.')
  },
  {
    id: 'Q06',
    text: 'How many people live in your household?',
    type: 'text',
    key: 'household',
    placeholder: 'e.g. 6'
  }
];

const $ = (id) => document.getElementById(id);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let records = JSON.parse(localStorage.getItem('aquaHubRecords') || '[]');
let interview = null;
let index = 0;
let startedAt = null;
let currentQuestionStartedAt = null;
let questionPauseStart = null;
let questionPauseSeconds = 0;
let currentQuestionPauseStart = null;
let currentQuestionPauseEnd = null;
let filter = 'all';
let recognition = null;
let listening = false;
let voiceUsed = false;
let currentQuestionAudioRecorder = null;
let currentQuestionAudioStream = null;
let currentQuestionAudioChunks = [];
let currentQuestionAudioData = '';
let currentQuestionTranscript = '';

function safeText(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function makeInterviewId() {
  return `INT${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}${Math.floor(Math.random() * 90 + 10)}`;
}

function updateVoiceStatus(message, isError = false) {
  const voiceStatus = $('voiceStatus');
  if (!voiceStatus) return;
  voiceStatus.textContent = message;
  voiceStatus.classList.toggle('error', isError);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function stopQuestionAudioCapture() {
  if (currentQuestionAudioRecorder && currentQuestionAudioRecorder.state !== 'inactive') {
    currentQuestionAudioRecorder.stop();
  }

  if (currentQuestionAudioStream) {
    currentQuestionAudioStream.getTracks().forEach((track) => track.stop());
    currentQuestionAudioStream = null;
  }
}

async function startQuestionAudioCapture() {
  const voiceButton = $('voiceButton');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (voiceButton) {
      voiceButton.disabled = true;
    }
    updateVoiceStatus('Microphone recording is unavailable in this browser.', true);
    return false;
  }

  stopQuestionAudioCapture();
  currentQuestionAudioChunks = [];
  currentQuestionAudioData = '';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    currentQuestionAudioStream = stream;

    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        currentQuestionAudioChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      if (!currentQuestionAudioChunks.length) {
        currentQuestionAudioData = '';
        return;
      }

      const blob = new Blob(currentQuestionAudioChunks, { type: recorder.mimeType || 'audio/webm' });
      currentQuestionAudioData = await blobToDataUrl(blob);
    };

    recorder.start(250);
    currentQuestionAudioRecorder = recorder;

    if (voiceButton) {
      voiceButton.disabled = true;
      voiceButton.setAttribute('aria-label', 'Voice recognition is automatic');
      voiceButton.title = 'Voice recognition is automatic while the interview is active';
    }

    return true;
  } catch (error) {
    updateVoiceStatus('Microphone permission is required for voice capture. Please allow access to continue.', true);
    return false;
  }
}

function initialiseVoice() {
  const voiceButton = $('voiceButton');

  if (!SpeechRecognition) {
    if (voiceButton) {
      voiceButton.disabled = true;
    }
    updateVoiceStatus('Voice recognition is not supported in this browser. Use Chrome or Microsoft Edge.', true);
    return false;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      listening = true;
      if (voiceButton) {
        voiceButton.classList.add('listening');
        voiceButton.setAttribute('aria-label', 'Voice recognition is automatic');
      }
      updateVoiceStatus('Listening… the interview is recording your spoken answer.');
    };

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(' ')
        .trim();

      currentQuestionTranscript = transcript;

      const input = $('responseInput');
      if (!input) return;

      input.value = transcript;
      voiceUsed = true;
      updateVoiceStatus(
        event.results[event.results.length - 1].isFinal ? 'Voice response captured and stored.' : 'Listening…'
      );
    };

    recognition.onerror = (event) => {
      const message =
        event.error === 'not-allowed'
          ? 'Microphone permission was denied. Allow it in your browser settings.'
          : `Voice recognition error: ${event.error}.`;
      updateVoiceStatus(message, true);
    };

    recognition.onend = () => {
      listening = false;
      if (voiceButton) {
        voiceButton.classList.remove('listening');
        voiceButton.setAttribute('aria-label', 'Voice recognition is automatic');
      }
      if ($('voiceStatus') && !$('voiceStatus').classList.contains('error')) {
        updateVoiceStatus('Voice capture is active. The spoken response is being stored automatically.');
      }
    };
  }

  return true;
}

function autoStartVoiceInput() {
  if (!initialiseVoice()) return;

  try {
    recognition.start();
  } catch (error) {
    // the recognizer may already be running; this is safe to ignore
  }
}

function toggleVoice() {
  autoStartVoiceInput();
}

function renderInputField(question) {
  const previous = $('responseInput');
  if (!previous) return;

  const input = document.createElement(question.type === 'select' ? 'select' : 'input');
  input.id = 'responseInput';

  if (question.type === 'select') {
    input.innerHTML =
      '<option value="">Select an answer</option>' +
      question.options.map((option) => `<option value="${option}">${option}</option>`).join('');
  } else {
    input.type = question.type;
    input.placeholder = question.placeholder || 'Type your answer';
    input.autocomplete = 'off';
    input.inputMode = 'text';
  }

  previous.replaceWith(input);
  input.focus();
}

function renderQuestion() {
  const question = questions[index];
  if (!question) return;

  const percent = Math.round(((index + 1) / questions.length) * 100);

  $('questionCode').textContent = question.id;
  $('questionText').textContent = question.text;
  $('progressText').textContent = `Question ${index + 1} of ${questions.length}`;
  $('progressPercent').textContent = `${percent}%`;
  $('progressBar').style.width = `${percent}%`;
  $('answerError').textContent = '';

  const liveCheck = $('liveCheck');
  if (liveCheck) {
    liveCheck.className = 'live-check';
    liveCheck.innerHTML =
      '<b>✓</b><div><strong>Ready to check</strong><small>Save an answer to run the quality check.</small></div>';
  }

  renderInputField(question);
  startedAt = startedAt || new Date();
  currentQuestionStartedAt = new Date();
  questionPauseStart = null;
  questionPauseSeconds = 0;
  currentQuestionPauseStart = null;
  currentQuestionPauseEnd = null;
  voiceUsed = false;
  currentQuestionTranscript = '';
  currentQuestionAudioData = '';
  updateVoiceStatus('Voice capture is on. The interviewer response is being recorded automatically.');

  if (SpeechRecognition) {
    startQuestionAudioCapture();
    autoStartVoiceInput();
  }
}

function startInterview() {
  const respondentName = $('respondentName').value.trim();
  if (!respondentName) {
    $('setupError').textContent = 'Enter the respondent name before starting.';
    $('respondentName').focus();
    return;
  }

  $('setupError').textContent = '';

  interview = {
    interviewId: makeInterviewId(),
    enumerator: $('enumerator').value,
    respondent: respondentName,
    startedAt: new Date().toISOString(),
    device: navigator.userAgent,
    pauses: [],
    answers: []
  };

  index = 0;
  $('setupCard').hidden = true;
  $('completionCard').hidden = true;
  $('interviewCard').hidden = false;
  $('interviewId').textContent = `Interview ${interview.interviewId}`;

  renderQuestion();
  initialiseVoice();
}

function detectAnomalies(question, value, duration) {
  const anomalies = [];
  const numericValue = Number.parseInt(value, 10);

  const duplicateAnswer = records.some(
    (record) =>
      record.respondent.toLowerCase() === interview.respondent.toLowerCase() &&
      record.answers.some(
        (answer) => answer.id === question.id && answer.response.toLowerCase() === value.toLowerCase()
      )
  );

  if (duration < 2) anomalies.push('Answer recorded unusually fast');
  if (duration > 180) anomalies.push('Long pause before response');
  if (questionPauseSeconds > 60) anomalies.push('Long pause/resume period recorded');
  if (duplicateAnswer) anomalies.push('Duplicate response found for this respondent');
  if (question.key === 'name' && value.toLowerCase() !== interview.respondent.toLowerCase()) {
    anomalies.push('Name does not match interview registration');
  }
  if (
    question.key === 'age' &&
    (!Number.isFinite(numericValue) || numericValue < 15 || numericValue > 120)
  ) {
    anomalies.push('Age is outside the expected range');
  }
  if (
    question.key === 'household' &&
    (!Number.isFinite(numericValue) || numericValue < 1 || numericValue > 40)
  ) {
    anomalies.push('Household size is outside the expected range');
  }

  const ageAnswer = interview.answers.find((answer) => answer.key === 'age');
  if (question.key === 'marital' && Number.parseInt(ageAnswer?.response, 10) < 18 && value === 'Married') {
    anomalies.push('Marital status conflicts with reported age');
  }

  return anomalies;
}

function togglePause() {
  if (!questionPauseStart) {
    questionPauseStart = new Date();
    currentQuestionPauseStart = questionPauseStart;
    currentQuestionPauseEnd = null;
    $('pauseButton').textContent = 'Resume interview';
    $('responseInput').disabled = true;
    $('submitButton').disabled = true;
    $('saveState').textContent = 'Interview paused';
    return;
  }

  const now = new Date();
  const pauseDuration = Math.round((now - questionPauseStart) / 1000);
  questionPauseSeconds += pauseDuration;
  currentQuestionPauseEnd = now;

  interview.pauses.push({
    pause_start: questionPauseStart.toISOString(),
    pause_end: now.toISOString(),
    pause_seconds: pauseDuration,
    question_id: questions[index].id,
    interview_id: interview.interviewId
  });

  questionPauseStart = null;
  currentQuestionPauseStart = null;
  $('pauseButton').textContent = 'Pause interview';
  $('responseInput').disabled = false;
  $('submitButton').disabled = false;
  $('responseInput').focus();
  $('saveState').textContent = `Resumed · ${questionPauseSeconds}s pause recorded`;
}

async function saveAnswer() {
  if (questionPauseStart) return;
  if (listening && recognition) recognition.stop();
  stopQuestionAudioCapture();

  const question = questions[index];
  const responseInput = $('responseInput');
  const value = responseInput.value.trim();

  if (!value) {
    $('answerError').textContent = 'A response is required.';
    responseInput.focus();
    return;
  }

  const answerCheck = question.check ? question.check(value) : null;
  if (answerCheck) {
    $('answerError').textContent = answerCheck;
    responseInput.focus();
    return;
  }

  const end = new Date();
  const totalQuestionMs = end - currentQuestionStartedAt;
  const duration = Math.max(0, Math.round((totalQuestionMs - questionPauseSeconds * 1000) / 1000));
  const flags = detectAnomalies(question, value, duration);

  const transcriptValue = currentQuestionTranscript || value;
  const answerRecord = {
    ...question,
    response: value,
    voice_transcript: transcriptValue,
    voice_audio_data: currentQuestionAudioData,
    response_source: voiceUsed ? 'voice' : 'typed',
    interview_started_at: startedAt.toISOString(),
    question_started_at: currentQuestionStartedAt.toISOString(),
    question_ended_at: end.toISOString(),
    question_duration_seconds: duration,
    pause_started_at: currentQuestionPauseStart ? currentQuestionPauseStart.toISOString() : null,
    pause_ended_at: currentQuestionPauseEnd ? currentQuestionPauseEnd.toISOString() : null,
    pause_seconds: questionPauseSeconds,
    response_time_seconds: duration,
    status: flags.length ? 'flagged' : 'normal',
    flags
  };

  interview.answers.push(answerRecord);

  const liveCheck = $('liveCheck');
  if (flags.length) {
    liveCheck.className = 'live-check flagged';
    liveCheck.innerHTML = `<b>!</b><div><strong>Flagged for supervisor review</strong><small>${safeText(flags.join(' · '))}</small></div>`;
    $('saveState').textContent = 'Anomaly recorded';
  } else {
    liveCheck.className = 'live-check normal';
    liveCheck.innerHTML = '<b>✓</b><div><strong>Normal response</strong><small>Answer and timing passed the quality check.</small></div>';
    $('saveState').textContent = 'Quality check passed';
  }

  setTimeout(() => {
    index += 1;
    if (index < questions.length) {
      renderQuestion();
    } else {
      completeInterview();
    }
  }, 700);
}

function completeInterview() {
  interview.completedAt = new Date().toISOString();
  records.unshift(interview);
  localStorage.setItem('aquaHubRecords', JSON.stringify(records));

  $('interviewCard').hidden = true;
  $('completionCard').hidden = false;

  const flaggedAnswers = interview.answers.filter((answer) => answer.status === 'flagged');
  $('completionMessage').textContent = flaggedAnswers.length
    ? `${flaggedAnswers.length} item${flaggedAnswers.length > 1 ? 's were' : ' was'} flagged for the AI supervisor.`
    : 'All timing records and responses passed the quality checks.';

  $('resultSummary').innerHTML = `
    <div><strong>${interview.answers.length}</strong><span>answers saved</span></div>
    <div><strong>${flaggedAnswers.length}</strong><span>anomalies flagged</span></div>
    <div><strong>${flaggedAnswers.length ? 'Needs review' : 'Normal'}</strong><span>interview status</span></div>
  `;

  if (interview.answers.length) {
    const firstQuestion = interview.answers[0];
    const lastQuestion = interview.answers[interview.answers.length - 1];
    $('completionMessage').textContent = `${flaggedAnswers.length ? `${flaggedAnswers.length} item${flaggedAnswers.length > 1 ? 's were' : ' was'} flagged for the AI supervisor.` : 'All timing records and responses passed the quality checks.'} Interview started at ${firstQuestion.question_started_at || interview.startedAt} and ended at ${lastQuestion.question_ended_at || interview.completedAt}.`;
  }

  $('answerTable').innerHTML = interview.answers
    .map(
      (answer) => `
        <tr>
          <td>${answer.id}</td>
          <td>${safeText(answer.response)}${answer.voice_transcript ? `<small class="finding">Voice: ${safeText(answer.voice_transcript)}</small>` : ''}</td>
          <td>${answer.response_time_seconds}s</td>
          <td>
            <em class="badge ${answer.status}">${answer.status === 'flagged' ? 'Flagged' : 'Normal'}</em>
            ${answer.flags.length ? `<small class="finding">${safeText(answer.flags.join('; '))}</small>` : ''}
            ${answer.voice_audio_data ? `<audio controls src="${answer.voice_audio_data}"></audio>` : ''}
          </td>
        </tr>
      `
    )
    .join('');

  updateSupervisorBadge();
}

function getAllAnswers() {
  return records.flatMap((record) =>
    record.answers.map((answer) => ({
      ...answer,
      respondent: record.respondent,
      interviewId: record.interviewId,
      enumerator: record.enumerator,
      device: record.device,
      interview_start: record.startedAt,
      interview_end: record.completedAt
    }))
  );
}

function renderMonitor() {
  const allAnswers = getAllAnswers();
  const flaggedCount = allAnswers.filter((answer) => answer.status === 'flagged').length;
  const visible = filter === 'all' ? allAnswers : allAnswers.filter((answer) => answer.status === filter);

  $('interviewTotal').textContent = records.length;
  $('answerTotal').textContent = allAnswers.length;
  $('flagTotal').textContent = flaggedCount;
  $('qualityRate').textContent = allAnswers.length ? `${Math.round(((allAnswers.length - flaggedCount) / allAnswers.length) * 100)}%` : '—';

  $('monitorTable').innerHTML = visible
    .map(
      (answer) => `
        <tr>
          <td><strong>${safeText(answer.respondent)}</strong><small>${answer.interviewId} · ${answer.enumerator}</small></td>
          <td>${answer.id}</td>
          <td>${safeText(answer.response)}${answer.voice_transcript ? `<small class="finding">Voice: ${safeText(answer.voice_transcript)}</small>` : ''}</td>
          <td>${answer.response_time_seconds}s${answer.pause_seconds ? `<small>${answer.pause_seconds}s paused</small>` : ''}</td>
          <td><em class="badge ${answer.status}">${answer.status === 'flagged' ? 'Flagged' : 'Normal'}</em></td>
          <td>
            ${answer.flags.length ? safeText(answer.flags.join('; ')) : `No inconsistency detected · ${safeText(answer.device || 'device not captured').slice(0, 42)}`}
            ${answer.voice_audio_data ? `<audio controls src="${answer.voice_audio_data}"></audio>` : ''}
          </td>
        </tr>
      `
    )
    .join('');

  $('emptyMonitor').hidden = visible.length > 0;
}

function updateSupervisorBadge() {
  const flaggedTotal = getAllAnswers().filter((answer) => answer.status === 'flagged').length;
  const badge = document.querySelector('.alert-count');
  if (!badge) return;
  badge.hidden = flaggedTotal === 0;
  badge.textContent = flaggedTotal;
}

function bindEvents() {
  document.querySelectorAll('.nav-toggle').forEach((button) => {
    button.onclick = () => changeView(button.dataset.view);
  });

  document.querySelectorAll('.filter').forEach((button) => {
    button.onclick = () => {
      filter = button.dataset.filter;
      document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
      renderMonitor();
    };
  });

  $('startButton').onclick = startInterview;
  $('pauseButton').onclick = togglePause;
  $('submitButton').onclick = saveAnswer;
  $('voiceButton').onclick = toggleVoice;
  $('voiceButton').disabled = true;
  $('voiceButton').title = 'Voice recognition is automatically active during the interview';

  $('newInterviewButton').onclick = () => {
    $('respondentName').value = '';
    $('setupCard').hidden = false;
    $('completionCard').hidden = true;
    $('respondentName').focus();
  };

  $('monitorButton').onclick = () => changeView('supervisor');

  $('clearDataButton').onclick = () => {
    if (confirm('Clear all locally saved demo interview records?')) {
      records = [];
      localStorage.removeItem('aquaHubRecords');
      updateSupervisorBadge();
      renderMonitor();
    }
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !$('interviewCard').hidden) {
      saveAnswer();
    }
  });
}

function changeView(view) {
  $('interviewView').hidden = view !== 'interview';
  $('supervisorView').hidden = view !== 'supervisor';
  $('pageTitle').textContent = view === 'interview' ? 'Interview questionnaire' : 'AI supervisor monitor';

  document.querySelectorAll('.nav-toggle').forEach((button) => {
    button.classList.toggle('selected', button.dataset.view === view);
  });

  if (view === 'supervisor') {
    renderMonitor();
  }
}

bindEvents();
updateSupervisorBadge();
