const questions = [
  { id: 'Q01', text: 'What is your name?', key: 'name', type: 'text' },
  { id: 'Q02', text: 'How old are you?', key: 'age', type: 'number', placeholder: 'e.g. 24' },
  {
    id: 'Q03',
    text: 'What is your main occupation?',
    key: 'occupation',
    type: 'select',
    options: ['Farming', 'Business', 'Salaried employment', 'Student', 'Other']
  },
  { id: 'Q04', text: 'What is your marital status?', key: 'marital', type: 'select', options: ['Single', 'Married', 'Divorced', 'Widowed'] },
  { id: 'Q05', text: 'Which district do you live in?', key: 'district', type: 'text' },
  { id: 'Q06', text: 'How many people live in your household?', key: 'household', type: 'number', placeholder: 'e.g. 6' }
];

const $ = (id) => document.getElementById(id);
const DB_NAME = 'aqua-hub-field-data';
const DB_VERSION = 1;
let currentUser = null;
let interview = null;
let questionStartedAt = null;
let questionPauseSeconds = 0;
let filter = 'all';
let recorder = null;
let mediaStream = null;
let audioChunks = [];
let speechRecognizer = null;
let draftSaveTimer = null;
let serverDraftQueue = Promise.resolve();
let monitorRecords = [];
let monitorAudit = [];
let installPrompt = null;
let supervisorRefreshTimer = null;

function safeText(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) {
        request.result.createObjectStore('drafts', { keyPath: 'interviewId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function draftRequest(mode, action, value) {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('drafts', mode);
    const store = transaction.objectStore('drafts');
    const request = action === 'getAll' ? store.getAll() : store[action](value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

function saveLocalDraft(draft) {
  return draftRequest('readwrite', 'put', draft);
}

function readLocalDrafts() {
  return draftRequest('readonly', 'getAll');
}

function removeLocalDraft(interviewId) {
  return draftRequest('readwrite', 'delete', interviewId);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof Blob)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.detail || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function safeInterviewPayload(draft) {
  const { pendingVoice, ...payload } = draft;
  return JSON.parse(JSON.stringify(payload));
}

function showConnectionState(message, state = 'online') {
  const status = $('connectionStatus');
  status.innerHTML = `<i></i>${safeText(message)}`;
  status.classList.toggle('offline', state === 'offline');
  status.classList.toggle('pending', state === 'pending');
}

function showApp(user, offline = false) {
  currentUser = user;
  if (user.mustChangePassword) {
    $('appShell').hidden = true;
    $('authScreen').hidden = false;
    $('loginForm').hidden = true;
    $('passwordChangeForm').hidden = false;
    return;
  }
  localStorage.setItem('aquaHubIdentity', JSON.stringify(user));
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  $('loginForm').hidden = false;
  $('passwordChangeForm').hidden = true;
  $('signedInUser').textContent = `${user.username} · ${user.role}`;
  $('enumerator').value = user.username;
  document.querySelectorAll('[data-view="supervisor"]').forEach((element) => {
    element.hidden = user.role !== 'supervisor';
  });
  showConnectionState(offline ? 'Offline · drafts saved on this device' : 'Connected', offline ? 'offline' : 'online');

  if (user.role === 'supervisor') {
    $('interviewView').hidden = true;
    $('supervisorView').hidden = false;
    $('pageTitle').textContent = 'Supervisor quality monitor';
    document.querySelectorAll('.nav-toggle').forEach((button) => button.classList.toggle('selected', button.dataset.view === 'supervisor'));
    if (!supervisorRefreshTimer) supervisorRefreshTimer = setInterval(refreshSupervisorMonitor, 30_000);
    refreshSupervisorMonitor();
    return;
  }

  $('interviewView').hidden = false;
  $('supervisorView').hidden = true;
  $('pageTitle').textContent = 'Interview questionnaire';
  clearInterval(supervisorRefreshTimer);
  supervisorRefreshTimer = null;
  loadEnumeratorDrafts();
}

function showLogin(message = '') {
  currentUser = null;
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  $('loginForm').hidden = false;
  $('passwordChangeForm').hidden = true;
  $('loginError').textContent = message;
}

async function signIn(event) {
  event.preventDefault();
  const button = $('loginButton');
  button.disabled = true;
  $('loginError').textContent = '';
  try {
    const user = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUsername').value, password: $('loginPassword').value })
    });
    $('loginPassword').value = '';
    showApp(user);
    if (user.role === 'enumerator') await syncQueuedDrafts();
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function changeTemporaryPassword(event) {
  event.preventDefault();
  const newPassword = $('newPassword').value;
  if (newPassword !== $('confirmPassword').value) {
    $('passwordChangeError').textContent = 'The passwords do not match.';
    return;
  }
  try {
    const user = await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ new_password: newPassword })
    });
    $('newPassword').value = '';
    $('confirmPassword').value = '';
    $('passwordChangeError').textContent = '';
    showApp(user);
  } catch (error) {
    $('passwordChangeError').textContent = error.message;
  }
}

async function signOut() {
  if (!navigator.onLine) {
    showConnectionState('Reconnect before signing out', 'pending');
    return;
  }
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    showConnectionState('Sign-out could not reach the server', 'pending');
    return;
  } finally {
  }
  localStorage.removeItem('aquaHubIdentity');
  interview = null;
  clearInterval(supervisorRefreshTimer);
  supervisorRefreshTimer = null;
  showLogin();
}

function interviewId() {
  return `INT${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
}

function newInterview(respondent) {
  return {
    interviewId: interviewId(),
    enumerator: currentUser.username,
    respondent,
    startedAt: new Date().toISOString(),
    voiceConsent: $('voiceConsent').checked,
    voiceConsentAt: $('voiceConsent').checked ? new Date().toISOString() : null,
    device: navigator.userAgent,
    pauses: [],
    answers: [],
    currentResponse: '',
    currentQuestionStartedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function setSaveStatus(message, state = '') {
  $('saveState').textContent = message;
  $('saveState').className = state;
}

function queueDraftSave() {
  if (!interview) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => saveDraft(), 400);
}

async function saveDraft() {
  if (!interview) return;
  interview.updatedAt = new Date().toISOString();
  try {
    await saveLocalDraft(interview);
  } catch (error) {
    setSaveStatus('Could not save this device draft', 'error');
    return;
  }

  if (!navigator.onLine || !currentUser) {
    setSaveStatus('Saved on this device · waiting to sync', 'pending');
    const payload = safeInterviewPayload(interview);
    const saveRequest = serverDraftQueue.catch(() => {}).then(() =>
      api('/api/interviews', { method: 'POST', body: JSON.stringify(payload) })
    );
    serverDraftQueue = saveRequest;
    const result = await saveRequest;
    if (interview?.interviewId === payload.interviewId && payload.completedAt) interview.status = result.status;
  }

  try {
    await api('/api/interviews', { method: 'POST', body: JSON.stringify(safeInterviewPayload(interview)) });
    showConnectionState('Connected');
    setSaveStatus(interview.completedAt ? 'Submission synced' : 'Draft saved securely');
    if (interview.completedAt) await removeLocalDraft(interview.interviewId);
  } catch (error) {
    setSaveStatus('Saved on this device · waiting to sync', 'pending');
    showConnectionState('Sync pending', 'pending');
  }
}

async function loadEnumeratorDrafts() {
  if (!currentUser || currentUser.role !== 'enumerator') return;
  const localDrafts = await readLocalDrafts().catch(() => []);
  let serverDrafts = [];
  if (navigator.onLine) {
    try {
      serverDrafts = await api('/api/interviews/drafts');
      for (const draft of serverDrafts) {
        if (!localDrafts.some((local) => local.interviewId === draft.interviewId)) {
          await saveLocalDraft(draft);
        }
      }
    } catch (error) {
      if (error.status === 401) return showLogin('Your session expired. Sign in again.');
    }
  }

  const drafts = [...serverDrafts, ...localDrafts]
    .filter((draft, index, list) => draft.enumerator === currentUser.username && list.findIndex((item) => item.interviewId === draft.interviewId) === index)
    .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''));
  $('draftResumeList').innerHTML = drafts.length
    ? `<h3>Saved interviews</h3>${drafts.map((draft) => `<button type="button" class="draft-resume" data-resume="${safeText(draft.interviewId)}"><span><strong>${safeText(draft.respondent)}</strong><small>${draft.answers.length} of ${questions.length} answers · ${draft.completedAt ? 'Waiting to sync' : 'Draft'}</small></span><b>Resume</b></button>`).join('')}`
    : '';
  $('draftResumeList').querySelectorAll('[data-resume]').forEach((button) => {
    button.onclick = () => resumeInterview(button.dataset.resume, drafts);
  });
}

async function syncQueuedDrafts() {
  if (!currentUser || currentUser.role !== 'enumerator' || !navigator.onLine) return;
  const drafts = await readLocalDrafts().catch(() => []);
  for (const draft of drafts.filter((item) => item.enumerator === currentUser.username)) {
    try {
      if (draft.pendingVoice?.blob) {
        const transcript = await transcribeAudio(draft.pendingVoice.blob);
        const answer = draft.answers.find((item) => item.id === draft.pendingVoice.questionId);
        if (answer) {
          answer.voice_transcript = transcript;
          answer.voice_text = transcript;
        } else {
          draft.currentResponse = transcript;
        }
        delete draft.pendingVoice;
        await saveLocalDraft(draft);
      }
      await api('/api/interviews', { method: 'POST', body: JSON.stringify(safeInterviewPayload(draft)) });
      if (draft.completedAt) await removeLocalDraft(draft.interviewId);
    } catch (error) {
      showConnectionState('Some records are waiting to sync', 'pending');
    }
  }
  if (interview) {
    const refreshed = drafts.find((draft) => draft.interviewId === interview.interviewId);
    if (refreshed) interview = refreshed;
  }
  if (navigator.onLine) showConnectionState('Connected');
  await loadEnumeratorDrafts();
}

function renderInputField(question, value) {
  const previous = $('responseInput');
  const input = document.createElement(question.type === 'select' ? 'select' : 'input');
  input.id = 'responseInput';
  if (question.type === 'select') {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Select an answer';
    input.append(empty);
    for (const optionText of question.options) {
      const option = document.createElement('option');
      option.value = optionText;
      option.textContent = optionText;
      input.append(option);
    }
  } else {
    input.type = question.type;
    input.placeholder = question.placeholder || 'Type your answer';
    input.inputMode = question.type === 'number' ? 'numeric' : 'text';
    input.autocomplete = 'off';
  }
  input.value = value || '';
  input.addEventListener('input', () => {
    interview.currentResponse = input.value;
    updateLiveAnomalyCheck(input.value);
    queueDraftSave();
  });
  input.addEventListener('change', () => {
    interview.currentResponse = input.value;
    updateLiveAnomalyCheck(input.value);
    queueDraftSave();
  });
  previous.replaceWith(input);
}

function renderQuestion() {
  if (!interview) return;
  const index = interview.answers.length;
  const question = questions[index];
  if (!question) return completeInterview();
  $('questionCode').textContent = question.id;
  $('questionText').textContent = question.text;
  $('progressText').textContent = `Question ${index + 1} of ${questions.length}`;
  $('progressPercent').textContent = `${Math.round(((index + 1) / questions.length) * 100)}%`;
  $('progressBar').style.width = `${Math.round(((index + 1) / questions.length) * 100)}%`;
  $('answerError').textContent = '';
  $('liveCheck').className = 'live-check';
  $('liveCheck').innerHTML = '<b>✓</b><div><strong>Ready to check</strong><small>Save an answer to run the quality check.</small></div>';
  renderInputField(question, interview.currentResponse);
  questionStartedAt = Date.now();
  questionPauseSeconds = interview.pauses
    .filter((pause) => pause.question_id === question.id)
    .reduce((total, pause) => total + Number(pause.pause_seconds || 0), 0);
  interview.currentQuestionStartedAt = new Date(questionStartedAt).toISOString();
  const paused = Boolean(interview.pauseStartedAt);
  $('pauseButton').dataset.paused = String(paused);
  $('pauseButton').textContent = paused ? 'Resume interview' : 'Pause interview';
  $('responseInput').disabled = paused;
  $('submitButton').disabled = paused;
  $('voiceButton').disabled = !interview.voiceConsent;
  updateVoiceStatus(interview.voiceConsent
    ? 'Tap the microphone to record an answer. Transcription runs securely on the server.'
    : 'Voice is off because respondent audio consent was not given. Typed answers remain available.');
  queueDraftSave();
}

function startInterview() {
  if (!currentUser || currentUser.role !== 'enumerator') return;
  const respondent = $('respondentName').value.trim();
  if (respondent.length < 2) {
    $('setupError').textContent = 'Enter the respondent name before starting.';
    $('respondentName').focus();
    return;
  }
  $('setupError').textContent = '';
  interview = newInterview(respondent);
  $('setupCard').hidden = true;
  $('completionCard').hidden = true;
  $('interviewCard').hidden = false;
  $('interviewId').textContent = `Interview ${interview.interviewId}`;
  renderQuestion();
}

async function resumeInterview(id, drafts) {
  interview = drafts.find((draft) => draft.interviewId === id);
  if (!interview) return;
  $('setupCard').hidden = true;
  $('completionCard').hidden = Boolean(interview.completedAt);
  $('interviewCard').hidden = Boolean(interview.completedAt);
  $('interviewId').textContent = `Interview ${interview.interviewId}`;
  if (interview.completedAt) {
    renderCompletion();
    return;
  }
  $('respondentName').value = interview.respondent;
  renderQuestion();
  if (interview.currentResponse) $('responseInput').value = interview.currentResponse;
}

function categoryLabel(category) {
  return ({ duplicate: 'Duplicate', completion_time: 'Completion time', missing_value: 'Missing value', inconsistency: 'Inconsistency' })[category] || 'Quality check';
}

function detectAnomalies(question, value, duration) {
  const flags = [];
  const response = value.trim();
  const add = (category, message) => flags.push({ category, message });
  if (duration < 2) add('completion_time', 'Answer recorded unusually fast');
  if (duration > 180) add('completion_time', 'Answer took longer than expected');
  if (questionPauseSeconds > 60) add('completion_time', 'Long pause period recorded');
  if (question.key === 'age' && (!/^\d+$/.test(response) || Number(response) < 15 || Number(response) > 120)) {
    add('inconsistency', 'Age is outside the expected range');
  }
  if (question.key === 'household' && (!/^\d+$/.test(response) || Number(response) < 1 || Number(response) > 40)) {
    add('inconsistency', 'Household size is outside the expected range');
  }
  if (question.key === 'name' && !/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]*$/.test(response)) {
    add('inconsistency', 'Name must be entered as text');
  }
  if (question.key === 'district' && !/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]*$/.test(response)) {
    add('inconsistency', 'District must be entered as a place name');
  }
  if (question.key === 'marital' && Number(interview.answers.find((answer) => answer.key === 'age')?.response) < 18 && response === 'Married') {
    add('inconsistency', 'Marital status conflicts with reported age');
  }
  return flags;
}

function updateVoiceStatus(message, isError = false) {
  $('voiceStatus').textContent = message;
  $('voiceStatus').classList.toggle('error', isError);
}

async function transcribeAudio(blob) {
  const response = await fetch('/api/voice/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.detail || 'Voice transcription failed.');
  return result.transcript || '';
}

function toggleResetAccess() {
  $('resetAccessForm').hidden = !$('resetAccessForm').hidden;
  $('resetAccessError').textContent = '';
}

async function resetLocalSupervisor(event) {
  event.preventDefault();
  const username = $('resetUsername').value.trim().toUpperCase();
  const password = $('resetPassword').value;
  if (password !== $('resetPasswordConfirm').value) {
    $('resetAccessError').textContent = 'The passwords do not match.';
    return;
  }
  try {
    await api('/api/auth/reset-local-supervisor', {
      method: 'POST', body: JSON.stringify({ username, new_password: password })
    });
    $('loginUsername').value = username;
    $('loginPassword').value = password;
    $('resetUsername').value = '';
    $('resetPassword').value = '';
    $('resetPasswordConfirm').value = '';
    $('resetAccessForm').hidden = true;
    $('loginError').textContent = 'Supervisor password reset. Click Sign in.';
  } catch (error) {
    $('resetAccessError').textContent = error.message;
  }
}

function updateLiveAnomalyCheck(value) {
  if (!interview || !questions[interview.answers.length]) return;
  const response = value.trim();
  if (!response) {
    $('liveCheck').className = 'live-check';
    $('liveCheck').innerHTML = '<b>✓</b><div><strong>Listening for a response</strong><small>Live quality checks will run as the answer is captured.</small></div>';
    return;
  }
  const question = questions[interview.answers.length];
  const liveFlags = detectAnomalies(question, response, Math.max(2, Math.round((Date.now() - questionStartedAt) / 1000)))
    .filter((flag) => flag.category !== 'completion_time');
  $('liveCheck').className = liveFlags.length ? 'live-check flagged' : 'live-check normal';
  $('liveCheck').innerHTML = liveFlags.length
    ? `<b>!</b><div><strong>Live quality warning</strong><small>${safeText(liveFlags.map((flag) => flag.message).join(' · '))}</small></div>`
    : '<b>✓</b><div><strong>Live check passed</strong><small>No response-format anomaly detected yet. Review before saving.</small></div>';
}

async function uploadInterviewAudio(blob, questionId) {
  const response = await fetch(`/api/interviews/${encodeURIComponent(interview.interviewId)}/audio?question_id=${encodeURIComponent(questionId)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.detail || 'Audio could not be saved.');
  return result;
}

function startLiveSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return false;
  speechRecognizer = new Recognition();
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = 'en-US';
  speechRecognizer.onresult = (event) => {
    let transcript = '';
    for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
    transcript = transcript.trim();
    if (!transcript || !interview) return;
    $('responseInput').value = transcript;
    interview.currentResponse = transcript;
    interview.currentVoiceTranscript = transcript;
    updateLiveAnomalyCheck(transcript);
    queueDraftSave();
  };
  speechRecognizer.onerror = () => updateVoiceStatus('Live speech analysis is unavailable; the audio recording will still be saved.', true);
  speechRecognizer.start();
  return true;
}

function stopLiveSpeechRecognition() {
  if (!speechRecognizer) return;
  speechRecognizer.onresult = null;
  try { speechRecognizer.stop(); } catch (error) { /* already stopped */ }
  speechRecognizer = null;
}

async function toggleVoice() {
  if (!interview?.voiceConsent) {
    updateVoiceStatus('Voice recording requires respondent consent. Typed answers remain available.', true);
    return;
  }
  if (recorder && recorder.state === 'recording') {
    stopLiveSpeechRecognition();
    recorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    $('voiceButton').classList.remove('listening');
    $('voiceButton').setAttribute('aria-label', 'Record answer using voice');
    $('voiceButton').title = 'Record answer using voice';
    $('voiceButton').disabled = true;
    updateVoiceStatus('Transcribing your answer...');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    updateVoiceStatus('Voice recording is unavailable in this browser. Type the response instead.', true);
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recorder = new MediaRecorder(mediaStream);
    recorder.ondataavailable = (event) => {
      if (event.data.size) audioChunks.push(event.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' });
      try {
        if (!navigator.onLine) throw new Error('offline');
        const questionId = questions[interview.answers.length].id;
        const audioRecord = await uploadInterviewAudio(blob, questionId);
        interview.currentVoiceAudio = audioRecord;
        const transcript = await transcribeAudio(blob);
        if (transcript) {
          $('responseInput').value = transcript;
          interview.currentResponse = transcript;
          interview.currentVoiceTranscript = transcript;
          updateLiveAnomalyCheck(transcript);
          queueDraftSave();
          updateVoiceStatus('Voice response transcribed. Review it before saving.');
        } else {
          updateVoiceStatus('No speech was detected. Type the response or record again.', true);
        }
      } catch (error) {
        interview.pendingVoice = { questionId: questions[interview.answers.length].id, blob };
        await saveLocalDraft(interview).catch(() => {});
        updateVoiceStatus('Voice saved on this device. Connect to transcribe it, or type the answer now.', true);
        setSaveStatus('Voice recording saved locally', 'pending');
      } finally {
        $('voiceButton').disabled = false;
      }
    };
    recorder.start();
    const liveAnalysis = startLiveSpeechRecognition();
    $('voiceButton').classList.add('listening');
    $('voiceButton').setAttribute('aria-label', 'Stop voice recording');
    $('voiceButton').title = 'Stop voice recording';
    updateVoiceStatus(liveAnalysis ? 'Recording and checking the answer live. Tap the microphone again when finished.' : 'Recording. Tap the microphone again when finished.');
  } catch (error) {
    updateVoiceStatus('Microphone permission was denied or unavailable. Type the response instead.', true);
  }
}

async function togglePause() {
  const button = $('pauseButton');
  if (button.dataset.paused !== 'true') {
    button.dataset.paused = 'true';
    button.textContent = 'Resume interview';
    $('responseInput').disabled = true;
    $('submitButton').disabled = true;
    interview.pauseStartedAt = Date.now();
    setSaveStatus('Interview paused');
    await saveDraft();
    return;
  }
  questionPauseSeconds += Math.round((Date.now() - Number(interview.pauseStartedAt)) / 1000);
  const pauseStartedAt = Number(interview.pauseStartedAt);
  const pauseDuration = Math.round((Date.now() - pauseStartedAt) / 1000);
  interview.pauseStartedAt = null;
  interview.pauses.push({
    pause_start: new Date(pauseStartedAt).toISOString(),
    pause_end: new Date().toISOString(),
    pause_seconds: pauseDuration,
    question_id: questions[interview.answers.length].id
  });
  button.dataset.paused = 'false';
  button.textContent = 'Pause interview';
  $('responseInput').disabled = false;
  $('submitButton').disabled = false;
  $('responseInput').focus();
  await saveDraft();
}

async function saveAnswer() {
  if (!interview || $('pauseButton').dataset.paused === 'true') return;
  const question = questions[interview.answers.length];
  const input = $('responseInput');
  const value = input.value.trim();
  if (!value) {
    $('answerError').textContent = 'A response is required.';
    input.focus();
    return;
  }
  if (question.key === 'name' && !/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]*$/.test(value)) {
    $('answerError').textContent = 'Name must be entered as text only.';
    input.focus();
    return;
  }
  if (question.key === 'district' && !/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]*$/.test(value)) {
    $('answerError').textContent = 'District must be entered as a place name.';
    input.focus();
    return;
  }
  const endedAt = new Date();
  const duration = Math.max(0, Math.round((endedAt.getTime() - questionStartedAt - questionPauseSeconds * 1000) / 1000));
  const flags = detectAnomalies(question, value, duration);
  const answer = {
    ...question,
    response: value,
    raw_response: value,
    rubric: question.text,
    voice_transcript: interview.currentVoiceTranscript || '',
    voice_text: interview.currentVoiceTranscript || '',
    response_source: interview.currentVoiceTranscript ? 'voice' : 'typed',
    audio_record: interview.currentVoiceAudio?.audioUrl || '',
    audio_recorded_at: interview.currentVoiceAudio?.recordedAt || null,
    interview_started_at: interview.startedAt,
    question_started_at: new Date(questionStartedAt).toISOString(),
    question_ended_at: endedAt.toISOString(),
    question_duration_seconds: duration,
    response_time_seconds: duration,
    pause_seconds: questionPauseSeconds,
    duplicate_count: 0,
    flags,
    status: flags.length ? 'flagged' : 'normal',
    response_status: flags.length ? 'flagged' : 'completed',
    anomaly_category: flags[0]?.category || 'normal',
    summary: `Pause: ${questionPauseSeconds}s | Start: ${new Date(questionStartedAt).toISOString()} | End: ${endedAt.toISOString()}`
  };
  interview.answers.push(answer);
  interview.currentResponse = '';
  interview.currentVoiceTranscript = '';
  interview.currentVoiceAudio = null;
  const liveCheck = $('liveCheck');
  if (flags.length) {
    liveCheck.className = 'live-check flagged';
    liveCheck.innerHTML = `<b>!</b><div><strong>Flagged for supervisor review</strong><small>${safeText(flags.map((flag) => flag.message).join(' · '))}</small></div>`;
    setSaveStatus('Quality finding recorded');
  } else {
    liveCheck.className = 'live-check normal';
    liveCheck.innerHTML = '<b>✓</b><div><strong>Response recorded</strong><small>Answer and timing checks passed.</small></div>';
    setSaveStatus('Response recorded');
  }
  $('submitButton').disabled = true;
  await saveDraft();
  if (interview.answers.length === questions.length) {
    await completeInterview();
    return;
  }
  interview.currentQuestionStartedAt = new Date().toISOString();
  renderQuestion();
}

async function completeInterview() {
  interview.completedAt = new Date().toISOString();
  await saveDraft();
  $('interviewCard').hidden = true;
  $('completionCard').hidden = false;
  renderCompletion();
  loadEnumeratorDrafts();
}

function renderCompletion() {
  const flagged = interview.answers.filter((answer) => answer.status === 'flagged').length;
  $('completionMessage').textContent = `${interview.answers.length} responses saved. ${flagged} quality finding${flagged === 1 ? '' : 's'} require supervisor review.`;
  $('resultSummary').innerHTML = `<div><strong>${interview.answers.length}</strong><span>answers saved</span></div><div><strong>${flagged}</strong><span>quality findings</span></div><div><strong>${interview.status === 'submitted' ? 'Submitted' : 'Queued'}</strong><span>server status</span></div>`;
  $('answerTable').innerHTML = interview.answers.map((answer) => `
    <tr><td>${safeText(answer.id)}</td><td>${safeText(answer.response)}</td><td>${answer.response_time_seconds}s</td>
    <td><em class="badge ${answer.status}">${answer.status === 'flagged' ? 'Review' : 'Normal'}</em></td></tr>`).join('');
}

function allAnswers(records) {
  return records.flatMap((record) => (record.answers || []).map((answer) => ({
    ...answer,
    respondent: record.respondent,
    interviewId: record.interviewId,
    enumerator: record.enumerator,
    device: record.device,
    interview_start: record.startedAt,
    interview_end: record.completedAt,
    interviewStatus: record.status,
    interviewRisk: record.quality_summary || {},
    interviewModel: record.model_assessment || null,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt
  })));
}

function flagText(flag) {
  return typeof flag === 'string' ? flag : flag?.message || 'Quality review required';
}

function flagCategory(flag) {
  return typeof flag === 'string' ? 'inconsistency' : flag?.category || 'inconsistency';
}

function renderAnomalySummary(flagged) {
  ensureModelStatus();
  const counts = {};
  for (const answer of flagged) {
    for (const flag of answer.flags || []) {
      const category = flagCategory(flag);
      counts[category] = (counts[category] || 0) + 1;
    }
  }
  $('anomalySummaryLabel').textContent = `${flagged.length} flagged answer${flagged.length === 1 ? '' : 's'}`;
  const categories = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  const mostCommon = categories[0];
  const modelFlagged = monitorRecords.filter((record) => record.model_assessment?.status === 'anomaly').length;
  const risk = flagged.length === 0 ? 'No flags' : flagged.length < 3 ? 'Low volume' : flagged.length < 7 ? 'Review' : 'Elevated';
  $('anomalySummaryStats').innerHTML = `
    <div><span>Flagged answers</span><strong>${flagged.length}</strong></div>
    <div><span>Flag events</span><strong>${Object.values(counts).reduce((sum, count) => sum + count, 0)}</strong></div>
    <div><span>Common category</span><strong>${safeText(mostCommon ? categoryLabel(mostCommon[0]) : 'None')}</strong></div>
    <div><span>Model-flagged interviews</span><strong>${modelFlagged}</strong></div>
    <div><span>Review level</span><strong>${risk}</strong></div>`;
  const colors = { duplicate: '#3867d6', completion_time: '#d98419', missing_value: '#21836f', inconsistency: '#c53b42' };
  const maximum = Math.max(1, ...categories.map(([, count]) => count));
  $('anomalyChart').innerHTML = categories.length ? categories.map(([category, count]) => `
    <div class="chart-bar-group"><strong>${count}</strong><div class="chart-bar" style="height:${Math.max(12, count / maximum * 100)}%;background:${colors[category] || '#087e78'}"></div><span>${safeText(categoryLabel(category))}</span></div>`).join('')
    : '<p class="anomaly-detail-empty">No quality findings in the current records.</p>';
  const details = flagged.flatMap((answer) => (answer.flags || []).map((flag) => ({ answer, flag })));
  const reviewActionsShown = new Set();
  $('anomalyDetailTable').innerHTML = details.length ? details.map(({ answer, flag }) => {
    const showReview = answer.interviewStatus === 'submitted' && !answer.reviewedBy && !reviewActionsShown.has(answer.interviewId);
    reviewActionsShown.add(answer.interviewId);
    const reviewCell = answer.reviewedBy
      ? `Reviewed by ${safeText(answer.reviewedBy)}`
      : showReview ? `<button type="button" class="review-btn" data-review="${safeText(answer.interviewId)}">Mark reviewed</button>` : 'Pending review';
    return `<tr><td>${safeText(answer.interviewId)}</td><td>${safeText(answer.enumerator)}</td><td>${safeText(answer.respondent)}</td>
      <td>${safeText(answer.id)}</td><td>${safeText(answer.response)}</td><td><span class="anomaly-badge ${safeText(flagCategory(flag))}">${safeText(categoryLabel(flagCategory(flag)))}</span></td>
      <td>${safeText(flagText(flag))}</td><td>${Number(answer.response_time_seconds) || 0}s</td><td>${reviewCell}</td></tr>`;
  }).join('')
    : '<tr><td colspan="9" class="anomaly-detail-empty">No answers need review.</td></tr>';
  $('anomalyDetailTable').querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/supervisor/interviews/${encodeURIComponent(button.dataset.review)}/review`, { method: 'POST' });
        await refreshSupervisorMonitor();
      } catch (error) {
        button.disabled = false;
        showConnectionState(error.message, 'offline');
      }
    });
  });
}

function ensureModelStatus() {
  if ($('modelStatus')) return;
  const status = document.createElement('span');
  status.id = 'modelStatus';
  status.className = 'model-status';
  status.textContent = 'Checking statistical model';
  document.querySelector('#supervisorView .anomaly-summary-card .summary-header').append(status);
}

function renderMonitor() {
  ensureEnumeratorPanel();
  ensureMonitorControls();
  const answers = allAnswers(monitorRecords);
  const flagged = answers.filter((answer) => answer.status === 'flagged');
  const query = $('monitorSearch').value.trim().toLowerCase();
  const enumerator = $('enumeratorFilter').value;
  const fromDate = $('monitorFromDate').value;
  const toDate = $('monitorToDate').value;
  const matching = answers.filter((answer) => {
    const searchable = `${answer.respondent} ${answer.enumerator} ${answer.interviewId} ${answer.id} ${answer.response}`.toLowerCase();
    const date = (answer.interview_start || '').slice(0, 10);
    return (!query || searchable.includes(query)) && (!enumerator || answer.enumerator === enumerator) &&
      (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  });
  const visible = filter === 'all' ? matching : matching.filter((answer) => filter === 'flagged' ? answer.status === 'flagged' : answer.status !== 'flagged');
  $('interviewTotal').textContent = monitorRecords.length;
  $('answerTotal').textContent = answers.length;
  $('flagTotal').textContent = flagged.length;
  $('qualityRate').textContent = answers.length ? `${Math.round((answers.length - flagged.length) / answers.length * 100)}%` : '—';
  const drafts = filter === 'all' ? monitorRecords.filter((record) => record.status === 'draft' &&
    (!enumerator || record.enumerator === enumerator) &&
    (!query || `${record.respondent} ${record.enumerator} ${record.interviewId}`.toLowerCase().includes(query)) &&
    (!fromDate || (record.startedAt || '').slice(0, 10) >= fromDate) &&
    (!toDate || (record.startedAt || '').slice(0, 10) <= toDate)) : [];
  const draftRows = drafts.map((record) => `
    <tr><td><strong>${safeText(record.respondent)}</strong><small>${safeText(record.interviewId)} · ${safeText(record.enumerator)}</small></td>
    <td>In progress</td><td>${record.answers.length} of ${questions.length} answers saved</td><td>—</td>
    <td><em class="badge normal">Draft</em></td><td>—</td><td>Last saved ${safeText(new Date(record.updatedAt).toLocaleString())}</td></tr>`);
  $('monitorTable').innerHTML = [...draftRows, ...visible.map((answer) => {
    const findings = (answer.flags || []).map(flagText).join('; ') || 'No automated flags';
    return `<tr><td><strong>${safeText(answer.respondent)}</strong><small>${safeText(answer.interviewId)} · ${safeText(answer.enumerator)}</small></td>
      <td>${safeText(answer.id)}</td><td>${safeText(answer.response)}</td><td>${Number(answer.response_time_seconds) || 0}s</td>
      <td><em class="badge ${answer.status === 'flagged' ? 'flagged' : 'normal'}">${answer.status === 'flagged' ? 'Review' : 'Normal'}</em></td>
      <td>Rules ${Number(answer.interviewRisk.risk_score) || 0}/100<small>Model: ${safeText(answer.interviewModel?.status || 'not scored')}${answer.interviewModel ? ` · score ${answer.interviewModel.anomaly_score}` : ''}</small></td>
      <td>${safeText(findings)}<small class="finding">${safeText(answer.summary || '')}</small><button type="button" class="record-btn" data-record="${safeText(answer.interviewId)}">View full record</button></td></tr>`;
  })].join('');
  $('monitorTable').querySelectorAll('[data-record]').forEach((button) => button.addEventListener('click', () => showFullInterviewRecord(button.dataset.record)));
  $('emptyMonitor').hidden = visible.length + drafts.length > 0;
  $('emptyMonitor').textContent = monitorRecords.length ? 'No answers match this filter.' : 'No interviews have been submitted yet.';
  renderAnomalySummary(flagged);
  $('auditTable').innerHTML = monitorAudit.length ? monitorAudit.map((event) => `
    <tr><td>${safeText(new Date(event.created_at).toLocaleString())}</td><td>${safeText(event.username)}</td>
    <td>${safeText(event.action.replaceAll('_', ' '))}</td><td>${safeText(event.interview_id || '—')}</td></tr>`).join('')
    : '<tr><td colspan="4" class="anomaly-detail-empty">No activity recorded.</td></tr>';
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

function showFullInterviewRecord(interviewId) {
  const record = monitorRecords.find((item) => item.interviewId === interviewId);
  if (!record) return;
  $('fullRecordCard').hidden = false;
  $('fullRecordTitle').textContent = `${record.interviewId} · ${record.respondent}`;
  const pauses = record.pauses || [];
  const totalPause = pauses.reduce((sum, pause) => sum + Number(pause.pause_seconds || 0), 0);
  $('fullRecordSummary').innerHTML = `<div><strong>${safeText(record.enumerator)}</strong><span>Enumerator</span></div><div><strong>${safeText(record.status || 'draft')}</strong><span>Status</span></div><div><strong>${totalPause}s</strong><span>Total pause time</span></div><div><strong>${formatDate(record.completedAt)}</strong><span>End time</span></div>`;
  $('fullRecordTimeline').innerHTML = `<h4>Interview timeline</h4><p>Started: <strong>${formatDate(record.startedAt)}</strong> · Last updated: <strong>${formatDate(record.updatedAt)}</strong> · Completed: <strong>${formatDate(record.completedAt)}</strong></p>${pauses.length ? `<p>Pauses: ${pauses.map((pause) => `${safeText(pause.question_id || 'Interview')} — ${formatDate(pause.pause_start)} to ${formatDate(pause.pause_end)} (${Number(pause.pause_seconds) || 0}s)`).join(' · ')}</p>` : '<p>No pauses recorded.</p>'}`;
  $('fullRecordAnswers').innerHTML = (record.answers || []).map((answer) => `<tr><td>${safeText(answer.id)}</td><td>${safeText(answer.response)}</td><td>${formatDate(answer.question_started_at)}</td><td>${formatDate(answer.question_ended_at)}</td><td>${Number(answer.response_time_seconds) || 0}s</td><td>${Number(answer.pause_seconds) || 0}s</td><td>${answer.audio_record ? `<audio controls preload="none" src="${safeText(answer.audio_record)}"></audio>` : 'No audio'}</td></tr>`).join('') || '<tr><td colspan="7">No answers saved yet.</td></tr>';
  $('fullRecordCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ensureEnumeratorPanel() {
  if ($('enumeratorPanel')) return;
  const panel = document.createElement('div');
  panel.id = 'enumeratorPanel';
  panel.className = 'card enumerator-panel';
  panel.innerHTML = `
    <div class="table-header"><div><p class="eyebrow">FIELD TEAM</p><h3>Enumerator accounts</h3></div></div>
    <form id="enumeratorForm" class="enumerator-form">
      <label>Username<input id="newEnumeratorUsername" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]+" autocomplete="off"></label>
      <label>Temporary password<input id="newEnumeratorPassword" type="password" required minlength="12" autocomplete="new-password"></label>
      <button class="secondary-btn" type="submit">Add enumerator</button>
    </form>
    <p id="enumeratorFormStatus" class="form-error" aria-live="polite"></p>
    <div class="table-wrap"><table><thead><tr><th>Enumerator</th><th>Status</th><th>Submitted</th><th>Drafts</th><th>Last activity</th><th>Account action</th></tr></thead><tbody id="enumeratorTable"></tbody></table></div>`;
  $('supervisorView').insertBefore(panel, document.querySelector('#supervisorView .anomaly-summary-card'));
  $('enumeratorForm').addEventListener('submit', createEnumerator);
}

async function refreshEnumeratorPanel() {
  if (!currentUser || currentUser.role !== 'supervisor') return;
  ensureEnumeratorPanel();
  try {
    const accounts = await api('/api/supervisor/enumerators');
    $('enumeratorTable').innerHTML = accounts.length ? accounts.map((account) => `
      <tr><td><strong>${safeText(account.username)}</strong></td>
      <td><em class="badge ${account.active ? 'normal' : 'flagged'}">${account.active ? 'Active' : 'Disabled'}</em></td>
      <td>${account.submitted_count}</td><td>${account.draft_count}</td>
      <td>${account.last_activity ? safeText(new Date(account.last_activity).toLocaleString()) : 'No activity'}</td>
      <td><button class="account-action" type="button" data-account="${safeText(account.username)}" data-active="${account.active ? 'false' : 'true'}">${account.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="anomaly-detail-empty">No enumerator accounts yet.</td></tr>';
    $('enumeratorTable').querySelectorAll('[data-account]').forEach((button) => {
      button.addEventListener('click', async () => {
        const activating = button.dataset.active === 'true';
        if (!activating && !confirm(`Disable ${button.dataset.account}? Their active sessions will be ended.`)) return;
        button.disabled = true;
        try {
          await api(`/api/supervisor/enumerators/${encodeURIComponent(button.dataset.account)}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: activating })
          });
          await refreshSupervisorMonitor();
        } catch (error) {
          button.disabled = false;
          $('enumeratorFormStatus').textContent = error.message;
        }
      });
    });
  } catch (error) {
    $('enumeratorFormStatus').textContent = error.message;
  }
}

async function createEnumerator(event) {
  event.preventDefault();
  const username = $('newEnumeratorUsername').value.trim().toUpperCase();
  const temporaryPassword = $('newEnumeratorPassword').value;
  const button = $('enumeratorForm').querySelector('button[type="submit"]');
  button.disabled = true;
  $('enumeratorFormStatus').textContent = '';
  try {
    await api('/api/supervisor/enumerators', {
      method: 'POST',
      body: JSON.stringify({ username, temporary_password: temporaryPassword })
    });
    $('newEnumeratorUsername').value = '';
    $('newEnumeratorPassword').value = '';
    $('enumeratorFormStatus').textContent = `Account created. Share the temporary password with ${username} securely; it will be changed at first sign-in.`;
    await refreshSupervisorMonitor();
  } catch (error) {
    $('enumeratorFormStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function ensureMonitorControls() {
  if ($('monitorSearch')) return;
  const header = document.querySelector('#supervisorView .monitor-card .table-header');
  const controls = document.createElement('div');
  controls.className = 'monitor-controls';
  controls.innerHTML = '<input id="monitorSearch" type="search" aria-label="Search interviews" placeholder="Search interviews"><select id="enumeratorFilter" aria-label="Filter by enumerator"><option value="">All enumerators</option></select><input id="monitorFromDate" type="date" aria-label="Start date"><input id="monitorToDate" type="date" aria-label="End date">';
  header.append(controls);
  for (const id of ['monitorSearch', 'enumeratorFilter', 'monitorFromDate', 'monitorToDate']) {
    $(id).addEventListener(id === 'enumeratorFilter' ? 'change' : 'input', renderMonitor);
  }
}

async function refreshSupervisorMonitor() {
  if (!currentUser || currentUser.role !== 'supervisor') return;
  try {
    const result = await api('/api/supervisor/dashboard');
    monitorRecords = result.interviews || [];
    monitorAudit = result.audit || [];
    ensureModelStatus();
    $('modelStatus').textContent = result.model?.status === 'active'
      ? `Isolation Forest active · ${result.model.scored_interviews} interviews · ${result.model.model_source}`
      : result.model?.status === 'ready'
        ? 'Isolation Forest ready · awaiting submissions'
        : 'Isolation Forest unavailable · rule checks active';
    ensureMonitorControls();
    const selector = $('enumeratorFilter');
    if (selector) {
      const selected = selector.value;
      const usernames = [...new Set(monitorRecords.map((record) => record.enumerator).filter(Boolean))].sort();
      selector.innerHTML = '<option value="">All enumerators</option>' + usernames.map((name) => `<option value="${safeText(name)}">${safeText(name)}</option>`).join('');
      selector.value = usernames.includes(selected) ? selected : '';
    }
    renderMonitor();
    await refreshEnumeratorPanel();
    showConnectionState('Live monitor connected');
  } catch (error) {
    $('emptyMonitor').hidden = false;
    $('emptyMonitor').textContent = error.status === 401 ? 'Your session expired. Sign in again.' : 'Monitor data is unavailable while offline.';
    if (error.status === 401) showLogin('Your session expired. Sign in again.');
    showConnectionState('Monitor unavailable', 'offline');
  }
}

function changeView(view) {
  if (view === 'supervisor' && currentUser?.role !== 'supervisor') return;
  if (view !== 'supervisor' && $('fullRecordCard')) $('fullRecordCard').hidden = true;
  $('interviewView').hidden = view !== 'interview';
  $('supervisorView').hidden = view !== 'supervisor';
  $('pageTitle').textContent = view === 'interview' ? 'Interview questionnaire' : 'Supervisor quality monitor';
  document.querySelectorAll('.nav-toggle').forEach((button) => button.classList.toggle('selected', button.dataset.view === view));
  if (view === 'supervisor') refreshSupervisorMonitor();
}

function bindEvents() {
  $('loginForm').addEventListener('submit', signIn);
  $('resetAccessButton').addEventListener('click', toggleResetAccess);
  $('resetAccessForm').addEventListener('submit', resetLocalSupervisor);
  $('passwordChangeForm').addEventListener('submit', changeTemporaryPassword);
  $('signOutButton').addEventListener('click', signOut);
  $('startButton').addEventListener('click', startInterview);
  $('pauseButton').addEventListener('click', togglePause);
  $('submitButton').addEventListener('click', saveAnswer);
  $('voiceButton').addEventListener('click', toggleVoice);
  $('monitorButton').addEventListener('click', () => changeView('supervisor'));
  $('newInterviewButton').addEventListener('click', () => {
    interview = null;
    $('respondentName').value = '';
    $('setupCard').hidden = false;
    $('completionCard').hidden = true;
    $('draftResumeList').focus?.();
  });
  $('clearDataButton').addEventListener('click', async () => {
    if (currentUser?.role !== 'supervisor' || !confirm('Permanently clear all server interview records?')) return;
    try {
      await api('/api/supervisor/interviews', { method: 'DELETE' });
      await refreshSupervisorMonitor();
    } catch (error) {
      showConnectionState(error.message, 'offline');
    }
  });
  $('closeRecordButton').addEventListener('click', () => { $('fullRecordCard').hidden = true; });
  document.querySelectorAll('.nav-toggle').forEach((button) => button.addEventListener('click', () => changeView(button.dataset.view)));
  document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
    renderMonitor();
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && interview && !$('interviewCard').hidden && document.activeElement?.id !== 'pauseButton') {
      event.preventDefault();
      saveAnswer();
    }
  });
  window.addEventListener('online', () => {
    showConnectionState('Connected');
    if (currentUser?.role === 'enumerator') syncQueuedDrafts();
    if (currentUser?.role === 'supervisor') refreshSupervisorMonitor();
  });
  window.addEventListener('offline', () => showConnectionState('Offline · drafts saved on device', 'offline'));
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('installButton').hidden = false;
  });
  $('installButton').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('installButton').hidden = true;
  });
}

async function boot() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  try {
    const user = await api('/api/auth/me');
    if (user.authenticated) {
      showApp(user);
      if (user.role === 'enumerator') await syncQueuedDrafts();
      return;
    }
    localStorage.removeItem('aquaHubIdentity');
  } catch (error) {
    if (error.status === 401) localStorage.removeItem('aquaHubIdentity');
  }
  if (!navigator.onLine) {
    try {
      const cachedUser = JSON.parse(localStorage.getItem('aquaHubIdentity') || 'null');
      if (cachedUser?.role === 'enumerator') {
        showApp(cachedUser, true);
        return;
      }
    } catch (error) {
      localStorage.removeItem('aquaHubIdentity');
    }
    showLogin('Connect to the internet and sign in before using Aqua Hub on this device.');
    return;
  }
  showLogin();
}

boot();
