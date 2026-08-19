const mockRetrieveCurriculumContext = jest.fn();
const mockRetrieveNcertImages = jest.fn();
jest.mock('../../services/rag', () => ({
  retrieveCurriculumContext: (...args) => mockRetrieveCurriculumContext(...args),
  retrieveNcertImages: (...args) => mockRetrieveNcertImages(...args),
}));

const mockRetrieveWebContext = jest.fn();
jest.mock('../../services/webSearch', () => ({
  retrieveWebContext: (...args) => mockRetrieveWebContext(...args),
}));

const { gatherAnswerContext } = require('../../services/ai-coach/context');

function ragResult(overrides = {}) {
  return {
    context: '', sources: [], images: [],
    meta: { strategy: 'none', strictCandidates: 0, broadCandidates: 0, selected: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRetrieveWebContext.mockResolvedValue({ context: '', sources: [], meta: { enabled: false, query: '', count: 0 } });
});

describe('gatherAnswerContext', () => {
  test('RAG finds context -> uses it directly, never calls web search', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'Fractions are parts of a whole.', sources: ['s1'] }));

    const result = await gatherAnswerContext({ question: 'What is a fraction?', curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });

    expect(result.context).toBe('Fractions are parts of a whole.');
    expect(result.sources).toEqual(['s1']);
    expect(mockRetrieveWebContext).not.toHaveBeenCalled();
  });

  test('RAG finds no context -> falls back to web search', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult());
    mockRetrieveWebContext.mockResolvedValueOnce({ context: 'Web-sourced answer.', sources: ['web-1'], meta: { enabled: true, query: 'fractions', count: 1 } });

    const result = await gatherAnswerContext({ question: 'What is a fraction?', curriculum: 'NCERT' });

    expect(result.context).toBe('Web-sourced answer.');
    expect(result.sources).toEqual(['web-1']);
    expect(mockRetrieveWebContext).toHaveBeenCalled();
  });

  test('RAG throws -> continues in no-context mode, still tries web search, no crash', async () => {
    mockRetrieveCurriculumContext.mockRejectedValueOnce(new Error('Qdrant down'));
    mockRetrieveWebContext.mockResolvedValueOnce({ context: 'Web fallback.', sources: [], meta: { enabled: true, query: 'x', count: 0 } });

    const result = await gatherAnswerContext({ question: 'What is a fraction?', curriculum: 'NCERT' });

    expect(result.context).toBe('Web fallback.');
  });

  test('web search throws -> no crash, context stays empty', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult());
    mockRetrieveWebContext.mockRejectedValueOnce(new Error('web down'));

    const result = await gatherAnswerContext({ question: 'What is a fraction?', curriculum: 'NCERT' });

    expect(result.context).toBe('');
  });

  test('IB PYP with RAG text context but no images -> falls back to NCERT images for the same topic', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'Some IB content', images: [] }));
    mockRetrieveNcertImages.mockResolvedValueOnce([{ url: 'ncert-image.png' }]);

    const result = await gatherAnswerContext({ question: 'Show me a diagram', curriculum: 'IB PYP', topic: 'Water Cycle' });

    expect(result.images).toEqual([{ url: 'ncert-image.png' }]);
    expect(mockRetrieveNcertImages).toHaveBeenCalledWith(expect.objectContaining({ topic: 'Water Cycle' }));
  });

  test('IB PYP: RAG already returned images -> the NCERT image fallback is skipped', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'Some IB content', images: [{ url: 'ib-image.png' }] }));

    const result = await gatherAnswerContext({ question: 'Show me a diagram', curriculum: 'IB PYP' });

    expect(result.images).toEqual([{ url: 'ib-image.png' }]);
    expect(mockRetrieveNcertImages).not.toHaveBeenCalled();
  });

  test('non-IB-PYP curriculum never triggers the NCERT image fallback, even with zero images', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'Some NCERT content', images: [] }));

    await gatherAnswerContext({ question: 'Show me a diagram', curriculum: 'NCERT' });

    expect(mockRetrieveNcertImages).not.toHaveBeenCalled();
  });

  test('the NCERT image fallback itself failing is silent — no crash, images just stay empty', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'Some IB content', images: [] }));
    mockRetrieveNcertImages.mockRejectedValueOnce(new Error('image search down'));

    const result = await gatherAnswerContext({ question: 'Show me a diagram', curriculum: 'IB PYP' });

    expect(result.images).toEqual([]);
  });

  test('ragMeta and webMeta are passed through untouched for analytics logging', async () => {
    const meta = { strategy: 'strict', strictCandidates: 3, broadCandidates: 0, selected: 2 };
    mockRetrieveCurriculumContext.mockResolvedValueOnce(ragResult({ context: 'x', meta }));

    const result = await gatherAnswerContext({ question: 'q', curriculum: 'NCERT' });

    expect(result.ragMeta).toEqual(meta);
    expect(result.webMeta).toEqual({ enabled: false, query: '', count: 0 });
  });
});
