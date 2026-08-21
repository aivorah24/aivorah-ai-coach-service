// Integration tests — hit the REAL routes/ask.js through Supertest. All
// services are mocked at the module boundary (their own logic is covered
// by the unit tests); this file's job is the route layer's own logic:
// validation, status-code mapping, SSE framing.

jest.mock('../../services/llm', () => ({
  generateAnswer: jest.fn(),
  generateAnswerStream: jest.fn(),
}));
jest.mock('../../services/ai-coach/context', () => ({ gatherAnswerContext: jest.fn() }));
jest.mock('../../services/ai-coach/lessonGrounding', () => ({ getLessonGrounding: jest.fn() }));
jest.mock('../../services/analytics', () => ({ logEvent: jest.fn().mockResolvedValue(null) }));
jest.mock('../../services/contentSafety', () => ({ checkInputSafety: jest.fn() }));
jest.mock('../../services/supabase', () => {
  const chain = { insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
  return { from: jest.fn(() => chain), _chain: chain };
});
// A single shared mock so tests can control what Groq returns regardless of
// how many times routes/ask.js lazy-`new Groq()`s per request (teacher/parent
// routes construct a fresh client inside each handler).
const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const mockPdfParse = jest.fn();
jest.mock('pdf-parse', () => (...args) => mockPdfParse(...args), { virtual: true });

const request = require('supertest');
const { generateAnswer, generateAnswerStream } = require('../../services/llm');
const { gatherAnswerContext } = require('../../services/ai-coach/context');
const { getLessonGrounding } = require('../../services/ai-coach/lessonGrounding');
const { logEvent } = require('../../services/analytics');
const { checkInputSafety } = require('../../services/contentSafety');
const supabase = require('../../services/supabase');
const app = require('../../index');

function ctx(overrides = {}) {
  return { context: '', sources: [], images: [], ragMeta: { strategy: 'none', strictCandidates: 0, broadCandidates: 0 }, webMeta: { count: 0 }, ...overrides };
}

// Several tests deliberately trigger the routes' own console.error/warn calls
// (safety blocks, simulated LLM/Supabase failures) — expected noise, not a
// sign of a real problem, so it's suppressed here to keep CI logs clean.
let consoleErrorSpy;
let consoleWarnSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  checkInputSafety.mockReturnValue({ safe: true });
  gatherAnswerContext.mockResolvedValue(ctx());
  getLessonGrounding.mockResolvedValue('');
  generateAnswer.mockResolvedValue('A fraction is a part of a whole.');
});

describe('POST /ask', () => {
  test('missing question -> 400', async () => {
    const res = await request(app).post('/ask').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('question is required');
  });

  test('a blank/whitespace-only question -> 400', async () => {
    const res = await request(app).post('/ask').send({ question: '   ' });
    expect(res.status).toBe(400);
  });

  test('a safe question -> 200 with the real generated answer', async () => {
    const res = await request(app).post('/ask').send({ question: 'What is a fraction?', userEmail: 'a@a.com' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('A fraction is a part of a whole.');
  });

  test('an unsafe question is blocked before the LLM call — returns the canned response', async () => {
    checkInputSafety.mockReturnValue({ safe: false, category: 'self_harm', response: 'Please talk to a trusted adult.' });

    const res = await request(app).post('/ask').send({ question: 'I want to hurt myself', userEmail: 'a@a.com' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Please talk to a trusted adult.');
    expect(generateAnswer).not.toHaveBeenCalled();
  });

  test('lesson grounding is prepended to RAG context before generating the answer', async () => {
    gatherAnswerContext.mockResolvedValueOnce(ctx({ context: 'RAG context here.' }));
    getLessonGrounding.mockResolvedValueOnce('AUTHORITATIVE LESSON: ...\n\n');

    await request(app).post('/ask').send({ question: 'x', topic: 'Fractions' });

    const callArg = generateAnswer.mock.calls[0][0];
    expect(callArg.context).toBe('AUTHORITATIVE LESSON: ...\n\nRAG context here.');
  });

  test('an off-topic redirect answer strips any images (never shown alongside a redirect)', async () => {
    gatherAnswerContext.mockResolvedValueOnce(ctx({ images: [{ url: 'x.png' }] }));
    generateAnswer.mockResolvedValueOnce("I'm your school AI Coach — I help with school subjects.");

    const res = await request(app).post('/ask').send({ question: 'x' });

    expect(res.body.images).toEqual([]);
  });

  test('a real answer keeps its images', async () => {
    gatherAnswerContext.mockResolvedValueOnce(ctx({ images: [{ url: 'x.png' }] }));

    const res = await request(app).post('/ask').send({ question: 'x' });

    expect(res.body.images).toEqual([{ url: 'x.png' }]);
  });

  test('an LLM failure -> 500, logs an error analytics event', async () => {
    generateAnswer.mockRejectedValueOnce(new Error('LLM down'));

    const res = await request(app).post('/ask').send({ question: 'x', userEmail: 'a@a.com' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Something went wrong. Please try again.');
    expect(logEvent).toHaveBeenCalledWith('ai_ask', expect.objectContaining({ status: 'error' }));
  });

  test('logs a success analytics event with the real RAG/web meta on success', async () => {
    gatherAnswerContext.mockResolvedValueOnce(ctx({ context: 'x', sources: [{ topic: 'Fractions' }], ragMeta: { strategy: 'strict_topic', strictCandidates: 3, broadCandidates: 0 }, webMeta: { count: 0 } }));

    await request(app).post('/ask').send({ question: 'x', userEmail: 'a@a.com', topic: 'Fractions' });

    expect(logEvent).toHaveBeenCalledWith('ai_ask', expect.objectContaining({
      status: 'success',
      meta: expect.objectContaining({ hasRagContext: true, sourceCount: 1, ragStrategy: 'strict_topic' }),
    }));
  });
});

describe('POST /ask/stream', () => {
  test('missing question -> 400, no SSE headers sent', async () => {
    const res = await request(app).post('/ask/stream').send({});
    expect(res.status).toBe(400);
  });

  test('an unsafe question -> plain JSON safety response (not SSE), no context/LLM calls', async () => {
    checkInputSafety.mockReturnValue({ safe: false, category: 'abuse', response: 'Please tell a trusted adult.' });

    const res = await request(app).post('/ask/stream').send({ question: 'unsafe', userEmail: 'a@a.com' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Please tell a trusted adult.');
    expect(gatherAnswerContext).not.toHaveBeenCalled();
  });

  test('a successful stream sends sources, then tokens, then done, as real SSE frames', async () => {
    gatherAnswerContext.mockResolvedValueOnce(ctx({ context: 'x', sources: [{ topic: 'Fractions' }] }));
    generateAnswerStream.mockImplementationOnce(async ({ onToken }) => {
      onToken('Hello ');
      onToken('world.');
      return 'Hello world.';
    });

    const res = await request(app).post('/ask/stream').send({ question: 'x', userEmail: 'a@a.com' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"sources"');
    expect(res.text).toContain('"type":"token","token":"Hello "');
    expect(res.text).toContain('"type":"done"');
  });

  test('a mid-stream failure sends an error frame instead of crashing the connection', async () => {
    generateAnswerStream.mockRejectedValueOnce(new Error('stream broke'));
    const res = await request(app).post('/ask/stream').send({ question: 'x' });
    expect(res.text).toContain('"type":"error"');
  });
});

describe('POST /ask/feedback', () => {
  test('missing rating -> 400', async () => {
    const res = await request(app).post('/ask/feedback').send({ studentEmail: 'a@a.com' });
    expect(res.status).toBe(400);
  });

  test('an out-of-range rating -> 400', async () => {
    const res = await request(app).post('/ask/feedback').send({ rating: 5 });
    expect(res.status).toBe(400);
  });

  test('a valid rating (1/2/3) -> 200, inserts a real session_feedback row', async () => {
    const res = await request(app).post('/ask/feedback').send({ studentEmail: 'a@a.com', rating: 2, grade: 'Grade 4', messageCount: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.feedback).toBe(2);
    expect(insertArg.total_tokens).toBe(6);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.insert.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/ask/feedback').send({ rating: 1 });
    expect(res.status).toBe(500);
  });
});

describe('POST /ask/teacher', () => {
  test('no question, image, or PDF -> 400', async () => {
    const res = await request(app).post('/ask/teacher').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('question or attachment required');
  });

  test('a plain text question -> 200 with the real Groq answer, using the text model', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sai Mohan needs help with Currency Conversion.' } }] });

    const res = await request(app).post('/ask/teacher').send({ question: 'Who needs help?', classSummary: 'Sai Mohan: 40% Currency Conversion' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Sai Mohan needs help with Currency Conversion.');
    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
  });

  test('the real class summary is injected into the system prompt', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });

    await request(app).post('/ask/teacher').send({ question: 'x', classSummary: 'Priya: 90% all topics, excellent progress' });

    const systemPrompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('Priya: 90% all topics, excellent progress');
  });

  test('no classSummary given -> the prompt says so explicitly, not left blank', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    await request(app).post('/ask/teacher').send({ question: 'x' });
    const systemPrompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('No class data provided.');
  });

  test('an image attachment -> uses the vision model, sends a real image_url content block', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'This looks correct, 8/10.' } }] });

    const res = await request(app).post('/ask/teacher').send({
      question: 'Grade this worksheet', imageBase64: 'ZmFrZS1pbWFnZQ==', imageType: 'image/png',
    });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('This looks correct, 8/10.');
    const call = mockGroqCreate.mock.calls[0][0];
    expect(call.model).toBe('meta-llama/llama-4-maverick-17b-128e-instruct');
    const userContent = call.messages[1].content;
    expect(userContent[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZS1pbWFnZQ==' } });
  });

  test('pdfText already provided (client-extracted) -> used directly, pdf-parse never called', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Graded.' } }] });

    await request(app).post('/ask/teacher').send({ question: 'Grade this', pdfText: 'Q1: 2+2=4' });

    expect(mockPdfParse).not.toHaveBeenCalled();
    const userContent = mockGroqCreate.mock.calls[0][0].messages[1].content;
    expect(userContent).toContain('Q1: 2+2=4');
  });

  test('pdfBase64 with no pdfText -> real pdf-parse extraction is used and appended', async () => {
    mockPdfParse.mockResolvedValueOnce({ text: 'Extracted worksheet text.' });
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Graded.' } }] });

    await request(app).post('/ask/teacher').send({ question: 'Grade this', pdfBase64: Buffer.from('fake-pdf').toString('base64') });

    const userContent = mockGroqCreate.mock.calls[0][0].messages[1].content;
    expect(userContent).toContain('Extracted worksheet text.');
  });

  test('a scanned PDF with no extractable text -> a helpful fallback message is used instead of empty content', async () => {
    mockPdfParse.mockResolvedValueOnce({ text: '' });
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });

    await request(app).post('/ask/teacher').send({ question: 'Grade this', pdfBase64: 'ZmFrZQ==', pdfName: 'worksheet.pdf' });

    const userContent = mockGroqCreate.mock.calls[0][0].messages[1].content;
    expect(userContent).toContain('worksheet.pdf');
    expect(userContent).toContain('scanned/image-based');
  });

  test('a pdf-parse failure -> a real error message is used instead of crashing the request', async () => {
    mockPdfParse.mockRejectedValueOnce(new Error('corrupt PDF'));
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });

    const res = await request(app).post('/ask/teacher').send({ question: 'Grade this', pdfBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    const userContent = mockGroqCreate.mock.calls[0][0].messages[1].content;
    expect(userContent).toContain('PDF parse error: corrupt PDF');
  });

  test('a Groq failure -> 500 with the real error message', async () => {
    mockGroqCreate.mockRejectedValueOnce(new Error('Groq down'));
    const res = await request(app).post('/ask/teacher').send({ question: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI error: Groq down');
  });
});

describe('POST /ask/parent', () => {
  test('missing question -> 400', async () => {
    const res = await request(app).post('/ask/parent').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('question is required');
  });

  test('a blank/whitespace-only question -> 400', async () => {
    const res = await request(app).post('/ask/parent').send({ question: '   ' });
    expect(res.status).toBe(400);
  });

  test('a real question -> 200 with the real Groq answer', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Your child is doing great with fractions!' } }] });

    const res = await request(app).post('/ask/parent').send({ question: 'How is my child doing?', childSummary: 'Aanya: 85% Fractions' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Your child is doing great with fractions!');
    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
  });

  test('the real child summary is injected into the system prompt, not the teacher-style class summary', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });

    await request(app).post('/ask/parent').send({ question: 'x', childSummary: 'Aanya: 85% Fractions, needs practice in Decimals' });

    const systemPrompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('Aanya: 85% Fractions, needs practice in Decimals');
    expect(systemPrompt).toContain('warm, supportive AI assistant');
  });

  test('no childSummary given -> the prompt says so explicitly', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    await request(app).post('/ask/parent').send({ question: 'x' });
    const systemPrompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('No child data available yet.');
  });

  test('a Groq failure -> 500 with the real error message', async () => {
    mockGroqCreate.mockRejectedValueOnce(new Error('Groq down'));
    const res = await request(app).post('/ask/parent').send({ question: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI error: Groq down');
  });
});
