// llm.js builds its Groq client array from process.env at module-load time,
// so tests that need to control key rotation/fallback re-require the module
// fresh (jest.resetModules()) after setting env vars, with groq-sdk mocked
// to hand back a distinct, controllable client per key.

const groqInstances = [];
jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => {
    const instance = { chat: { completions: { create: jest.fn() } } };
    groqInstances.push(instance);
    return instance;
  });
});

const mockLogLLMCall = jest.fn();
jest.mock('../../services/tokenLogger', () => ({ logLLMCall: (...args) => mockLogLLMCall(...args) }));

function freshLLM(envKeys = ['GROQ_API_KEY']) {
  jest.resetModules();
  groqInstances.length = 0;
  ['GROQ_API_KEY', 'GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4'].forEach(k => delete process.env[k]);
  envKeys.forEach((k, i) => { process.env[k] = `fake-key-${i}`; });
  return require('../../services/llm');
}

beforeEach(() => {
  jest.clearAllMocks();
  delete global.fetch;
});

// ── getAgeGuardrails (pure) ──────────────────────────────────────────────
describe('getAgeGuardrails', () => {
  test.each([
    ['Grade 1', /Grades 1-2/],
    ['Grade 3', /Grade 3 \(age 8-9\)/],
    ['Grade 4', /Grade 4 \(age 9-10\)/],
    ['Grade 5', /Grade 5 \(age 10-11\)/],
    ['Grade 7', /Grades 6-8/],
    ['Grade 9', /Grades 9-10/],
    ['Grade 11', /Grades 11-12/],
  ])('%s -> matches the expected age band', (grade, re) => {
    const { getAgeGuardrails } = freshLLM();
    expect(getAgeGuardrails(grade)).toMatch(re);
  });

  test('an unparseable grade -> the generic fallback', () => {
    const { getAgeGuardrails } = freshLLM();
    expect(getAgeGuardrails('')).toBe('Age-appropriate simple language. Be encouraging.');
  });

  test('a Roman-numeral grade (e.g. "Class XI") is parsed correctly', () => {
    const { getAgeGuardrails } = freshLLM();
    expect(getAgeGuardrails('Class XI')).toMatch(/Grades 11-12/);
  });
});

// ── buildPrompts (pure, via its exported behavior) ───────────────────────
describe('buildPrompts', () => {
  test('no context provided -> hasContext is false, prompt says to use general knowledge', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is a fraction?', grade: 'Grade 4' });
    expect(result.hasContext).toBe(false);
    expect(result.systemPrompt).toContain('No curriculum content snippet available');
  });

  test('context provided -> hasContext is true, curriculum content block appears in the user prompt', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is a fraction?', context: 'Fractions represent parts of a whole.', grade: 'Grade 4', topic: 'Fractions' });
    expect(result.hasContext).toBe(true);
    expect(result.userPrompt).toContain('Fractions represent parts of a whole.');
  });

  test('a math-signal question sets mathMode: true', () => {
    const { buildPrompts } = freshLLM();
    expect(buildPrompts({ question: 'How do I add two fractions?', grade: 'Grade 4' }).mathMode).toBe(true);
  });

  test('a non-math question sets mathMode: false', () => {
    const { buildPrompts } = freshLLM();
    expect(buildPrompts({ question: 'What is photosynthesis?', grade: 'Grade 4' }).mathMode).toBe(false);
  });

  test('senior grades (9+) get the board-exam persona, not the playful one', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'Explain Newton\'s laws', grade: 'Grade 11' });
    expect(result.systemPrompt).toContain('serious young adult preparing for board examinations');
    // Junior's positive instruction to actively USE this cheerleader phrase must
    // not appear for seniors (the phrase itself does appear, but only inside the
    // senior prompt's list of phrases to AVOID — that's the correct, opposite instruction).
    expect(result.systemPrompt).not.toContain('Use "Great question!"');
  });

  test('junior grades (1-5) keep the warm, playful persona', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is a fraction?', grade: 'Grade 3' });
    expect(result.systemPrompt).toContain('warm, enthusiastic, patient AI tutor');
  });

  test('a short reply following an AI-asked practice question triggers the practice-evaluation teaching rule and a lower token budget', () => {
    const { buildPrompts } = freshLLM();
    const history = [{ role: 'assistant', text: 'Try this: what is 2 + 2?' }];
    const result = buildPrompts({ question: '4', grade: 'Grade 4', history });
    expect(result.systemPrompt).toContain('STUDENT ANSWERED YOUR PRACTICE QUESTION');
    expect(result.maxTokens).toBe(350);
  });

  test('a normal (non-practice-reply) question gets the full 900-token budget', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is a fraction?', grade: 'Grade 4' });
    expect(result.maxTokens).toBe(900);
  });

  test('a topic is given -> the scope rule locks to that topic', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'x', grade: 'Grade 4', topic: 'Fractions', subject: 'Mathematics' });
    expect(result.systemPrompt).toContain('Topic lock: only answer about "Fractions"');
  });

  test('Indian large-number phrasing (lakh/crore) triggers the Indian number system rule', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is 5 lakh in numbers?', grade: 'Grade 5' });
    expect(result.systemPrompt).toContain('INDIAN NUMBER SYSTEM');
  });

  test('an ordinary question does not include the Indian number system rule', () => {
    const { buildPrompts } = freshLLM();
    const result = buildPrompts({ question: 'What is a fraction?', grade: 'Grade 4' });
    expect(result.systemPrompt).not.toContain('INDIAN NUMBER SYSTEM');
  });

  test('history is capped to the last 6 valid turns and formatted with speaker labels', () => {
    const { buildPrompts } = freshLLM();
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `turn ${i}` }));
    const result = buildPrompts({ question: 'x', grade: 'Grade 4', history });
    // Last 6 of 10 turns (indices 4-9) survive; turn 9 is index 9 (even index = user,
    // so odd index 9 -> assistant -> labeled "Ms. Zara").
    expect(result.userPrompt).toContain('Ms. Zara: turn 9');
    expect(result.userPrompt).not.toContain('turn 3');
  });
});

// ── buildNoContextFallback (pure) ────────────────────────────────────────
describe('buildNoContextFallback', () => {
  test('includes the topic and grade in the fallback message', () => {
    const { buildNoContextFallback } = freshLLM();
    const msg = buildNoContextFallback({ topic: 'Fractions', grade: 'Grade 4' });
    expect(msg).toContain('Fractions');
    expect(msg).toContain('Grade 4');
  });

  test('no grade given -> falls back to "your grade"', () => {
    const { buildNoContextFallback } = freshLLM();
    expect(buildNoContextFallback({ topic: 'Fractions' })).toContain('your grade');
  });
});

// ── generateAnswer (orchestration: Groq -> key rotation -> NVIDIA) ──────
describe('generateAnswer', () => {
  test('a successful Groq call returns the answer and logs the LLM call', async () => {
    const { generateAnswer } = freshLLM();
    groqInstances[0].chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'A fraction is a part of a whole.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });

    const answer = await generateAnswer({ question: 'What is a fraction?', grade: 'Grade 4' });

    expect(answer).toBe('A fraction is a part of a whole.');
    expect(mockLogLLMCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq', promptTokens: 10, completionTokens: 20 }));
  });

  test('a rate-limited first key rotates to the second key, which succeeds', async () => {
    const { generateAnswer } = freshLLM(['GROQ_API_KEY', 'GROQ_API_KEY_1']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit exceeded' });
    groqInstances[1].chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'Second key answer.' } }],
      usage: {},
    });

    const answer = await generateAnswer({ question: 'x', grade: 'Grade 4' });

    expect(answer).toBe('Second key answer.');
  });

  test('a non-rate-limit error is thrown immediately, not swallowed as a rotation trigger', async () => {
    const { generateAnswer } = freshLLM();
    groqInstances[0].chat.completions.create.mockRejectedValueOnce(new Error('totally unrelated failure'));

    await expect(generateAnswer({ question: 'x', grade: 'Grade 4' })).rejects.toThrow('totally unrelated failure');
  });

  test('every Groq key rate-limited -> falls back to NVIDIA NIM', async () => {
    const { generateAnswer } = freshLLM(['GROQ_API_KEY']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit' });
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'NVIDIA fallback answer.' } }] }),
    });

    const answer = await generateAnswer({ question: 'x', grade: 'Grade 4' });

    expect(answer).toBe('NVIDIA fallback answer.');
    expect(mockLogLLMCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'nvidia' }));
  });

  test('NVIDIA itself failing -> the error propagates (no silent empty answer)', async () => {
    const { generateAnswer } = freshLLM(['GROQ_API_KEY']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit' });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'NVIDIA down' });

    await expect(generateAnswer({ question: 'x', grade: 'Grade 4' })).rejects.toThrow('NVIDIA NIM 500');
  });
});

// ── generateAnswerStream (orchestration) ─────────────────────────────────
describe('generateAnswerStream', () => {
  function fakeGroqStream(chunks) {
    return { [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  }

  test('streams tokens via onToken and returns the fully assembled text', async () => {
    const { generateAnswerStream } = freshLLM();
    groqInstances[0].chat.completions.create.mockResolvedValueOnce(fakeGroqStream([
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'world.' } }], x_groq: { usage: { prompt_tokens: 5, completion_tokens: 2 } } },
    ]));
    const tokens = [];

    const full = await generateAnswerStream({ question: 'x', grade: 'Grade 4', onToken: (t) => tokens.push(t) });

    expect(tokens).toEqual(['Hello ', 'world.']);
    expect(full).toBe('Hello world.');
    expect(mockLogLLMCall).toHaveBeenCalledWith(expect.objectContaining({ streamed: true, promptTokens: 5, completionTokens: 2 }));
  });

  test('a mid-stream failure with tokens already emitted is NOT retried on another key (would duplicate output)', async () => {
    const { generateAnswerStream } = freshLLM(['GROQ_API_KEY', 'GROQ_API_KEY_1']);
    groqInstances[0].chat.completions.create.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial ' } }] };
        throw { status: 429, message: 'rate_limit mid-stream' };
      },
    });

    await expect(generateAnswerStream({ question: 'x', grade: 'Grade 4', onToken: () => {} })).rejects.toBeTruthy();
    expect(groqInstances[1].chat.completions.create).not.toHaveBeenCalled();
  });

  test('a rate-limit BEFORE any token is emitted rotates cleanly to the next key', async () => {
    const { generateAnswerStream } = freshLLM(['GROQ_API_KEY', 'GROQ_API_KEY_1']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit' });
    groqInstances[1].chat.completions.create.mockResolvedValueOnce(fakeGroqStream([
      { choices: [{ delta: { content: 'ok' } }] },
    ]));
    const tokens = [];

    const full = await generateAnswerStream({ question: 'x', grade: 'Grade 4', onToken: (t) => tokens.push(t) });

    expect(full).toBe('ok');
  });

  test('every key exhausted -> falls back to NVIDIA, emitting the whole answer as one token', async () => {
    const { generateAnswerStream } = freshLLM(['GROQ_API_KEY']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit' });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'NVIDIA stream fallback.' } }] }) });
    const tokens = [];

    const full = await generateAnswerStream({ question: 'x', grade: 'Grade 4', onToken: (t) => tokens.push(t) });

    expect(tokens).toEqual(['NVIDIA stream fallback.']);
    expect(full).toBe('NVIDIA stream fallback.');
  });
});

// ── generateJSON (orchestration) ─────────────────────────────────────────
describe('generateJSON', () => {
  test('parses a plain JSON response', async () => {
    const { generateJSON } = freshLLM();
    groqInstances[0].chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: '{"answer": 42}' } }],
      usage: {},
    });
    const result = await generateJSON({ systemPrompt: 's', userPrompt: 'u' });
    expect(result).toEqual({ answer: 42 });
  });

  test('strips a markdown ```json fenced code block before parsing', async () => {
    const { generateJSON } = freshLLM();
    groqInstances[0].chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: '```json\n{"answer": 42}\n```' } }],
      usage: {},
    });
    const result = await generateJSON({ systemPrompt: 's', userPrompt: 'u' });
    expect(result).toEqual({ answer: 42 });
  });

  test('every Groq key rate-limited -> parses the NVIDIA fallback response too', async () => {
    const { generateJSON } = freshLLM(['GROQ_API_KEY']);
    groqInstances[0].chat.completions.create.mockRejectedValueOnce({ status: 429, message: 'rate_limit' });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok": true}' } }] }) });

    const result = await generateJSON({ systemPrompt: 's', userPrompt: 'u' });

    expect(result).toEqual({ ok: true });
  });

  test('malformed JSON from the model throws rather than returning garbage', async () => {
    const { generateJSON } = freshLLM();
    groqInstances[0].chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'not json at all' } }],
      usage: {},
    });
    await expect(generateJSON({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow();
  });
});
