const mockEmbed = jest.fn();
jest.mock('../../services/embeddings', () => ({ embed: (...args) => mockEmbed(...args) }));

const mockSearchContent = jest.fn();
const mockResolveCollection = jest.fn();
jest.mock('../../services/qdrant', () => ({
  searchContent: (...args) => mockSearchContent(...args),
  resolveCollection: (...args) => mockResolveCollection(...args),
}));

const mockResolveImageUrl = jest.fn();
jest.mock('../../services/cloudinaryUrls', () => ({ resolveImageUrl: (...args) => mockResolveImageUrl(...args) }));

const rag = require('../../services/rag');

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue([0.1, 0.2]);
  mockResolveCollection.mockReturnValue({ collection: 'ai_mentor_content', qdrantCurriculum: 'IB_PYP', qdrantGrade: 'Grade 4' });
});

describe('overlapRatio (pure)', () => {
  test('identical text -> full overlap (1)', () => {
    expect(rag.overlapRatio('fractions and decimals', 'fractions and decimals')).toBe(1);
  });

  test('no shared words -> 0', () => {
    expect(rag.overlapRatio('fractions', 'photosynthesis')).toBe(0);
  });

  test('empty input on either side -> 0, no crash', () => {
    expect(rag.overlapRatio('', 'fractions')).toBe(0);
    expect(rag.overlapRatio('fractions', '')).toBe(0);
  });

  test('short words (<3 chars) are ignored, so noise words do not inflate the ratio', () => {
    // "is", "a", "of" are all <3 chars and filtered out by tokenize().
    expect(rag.overlapRatio('is a fraction', 'of a whole')).toBeCloseTo(0);
  });
});

describe('isLikelyFollowUp (pure)', () => {
  test('a short question with a follow-up hint word -> true', () => {
    expect(rag.isLikelyFollowUp('another example please')).toBe(true);
  });

  test('a long question, even with a hint word -> false (too long to be a bare follow-up)', () => {
    expect(rag.isLikelyFollowUp('can you give me another example of how fractions work in real life situations')).toBe(false);
  });

  test('a short question with no hint word -> false', () => {
    expect(rag.isLikelyFollowUp('what is a fraction')).toBe(false);
  });

  test('empty question -> false', () => {
    expect(rag.isLikelyFollowUp('')).toBe(false);
  });
});

describe('inferSubjectFromText (pure)', () => {
  test('math keywords -> Mathematics', () => {
    expect(rag.inferSubjectFromText({ question: 'How do I add two fractions?' })).toBe('Mathematics');
  });

  test('science keywords -> Science', () => {
    expect(rag.inferSubjectFromText({ question: 'How does photosynthesis work?' })).toBe('Science');
  });

  test('math signal takes priority when both math and science keywords are present', () => {
    expect(rag.inferSubjectFromText({ question: 'What is the area of a leaf in photosynthesis?' })).toBe('Mathematics');
  });

  test('no recognizable signal -> empty string', () => {
    expect(rag.inferSubjectFromText({ question: 'Tell me a story about a king' })).toBe('');
  });

  test('topic and history text are also searched for signals, not just the question', () => {
    expect(rag.inferSubjectFromText({ question: 'Explain more', topic: 'Algebra' })).toBe('Mathematics');
    expect(rag.inferSubjectFromText({ question: 'Explain more', history: [{ text: 'What is an ecosystem?' }] })).toBe('Science');
  });
});

describe('rankResults (pure)', () => {
  function result(score, payload) { return { score, payload }; }

  test('blends 80% vector score with 20% lexical overlap, sorted descending', () => {
    const results = [
      result(0.5, { topic: 'Unrelated Topic', content: 'nothing matching here' }),
      result(0.4, { topic: 'Fractions', content: 'fractions are parts of a whole' }),
    ];
    const ranked = rag.rankResults({ results, question: 'fractions parts whole', topic: '', minScore: 0, minVectorScore: 0, max: 10 });
    // Second result should outrank the first despite a lower raw vector score, because of much higher lexical overlap.
    expect(ranked[0].payload.topic).toBe('Fractions');
  });

  test('results below minVectorScore are excluded even if blendedScore would pass', () => {
    const results = [result(0.05, { topic: 'fractions', content: 'fractions fractions fractions' })];
    const ranked = rag.rankResults({ results, question: 'fractions', topic: '', minScore: 0, minVectorScore: 0.18, max: 10 });
    expect(ranked).toHaveLength(0);
  });

  test('results below minScore (blended) are excluded', () => {
    const results = [result(0.1, { topic: 'unrelated', content: 'nothing matching' })];
    const ranked = rag.rankResults({ results, question: 'fractions', topic: '', minScore: 0.5, minVectorScore: 0, max: 10 });
    expect(ranked).toHaveLength(0);
  });

  test('respects the max cap after sorting', () => {
    const results = [result(0.9, { topic: 'a' }), result(0.8, { topic: 'b' }), result(0.7, { topic: 'c' })];
    const ranked = rag.rankResults({ results, question: 'x', topic: '', minScore: 0, minVectorScore: 0, max: 2 });
    expect(ranked).toHaveLength(2);
  });

  test('missing payload does not crash the ranking', () => {
    const ranked = rag.rankResults({ results: [{ score: 0.5 }], question: 'x', topic: '', minScore: 0, minVectorScore: 0, max: 10 });
    expect(ranked).toHaveLength(1);
  });
});

describe('buildImages (pure)', () => {
  test('filters out non-image chunks', () => {
    const results = [
      { payload: { content_type: 'text', text: 'not an image' } },
      { payload: { content_type: 'image', image_url: 'https://cdn/a.png', text: 'A labeled diagram.' } },
    ];
    const images = rag.buildImages(results);
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://cdn/a.png');
  });

  test('strips the leading "[IMAGE]" marker and markdown emphasis from the caption, keeps only the first line', () => {
    const results = [{ payload: { content_type: 'image', image_url: 'x.png', text: '[IMAGE] **A cell** diagram\nSecond line ignored' } }];
    const images = rag.buildImages(results);
    expect(images[0].caption).toBe('A cell diagram');
  });

  test('falls back to resolveImageUrl(image_path) when image_url is missing', () => {
    mockResolveImageUrl.mockReturnValueOnce('/data/images/resolved.png');
    const results = [{ payload: { content_type: 'image', image_path: 'ncert/grade3/x.png', text: 'caption' } }];
    const images = rag.buildImages(results);
    expect(images[0].url).toBe('/data/images/resolved.png');
    expect(mockResolveImageUrl).toHaveBeenCalledWith('ncert/grade3/x.png');
  });

  test('an image chunk with neither image_url nor image_path is excluded entirely', () => {
    const results = [{ payload: { content_type: 'image', text: 'no url at all' } }];
    expect(rag.buildImages(results)).toHaveLength(0);
  });
});

describe('buildRetrievalQuestion (pure)', () => {
  test('a topic is given -> question passes through unchanged (no follow-up expansion)', () => {
    expect(rag.buildRetrievalQuestion({ question: 'more please', topic: 'Fractions', history: [] })).toBe('more please');
  });

  test('not a likely follow-up -> question passes through unchanged', () => {
    expect(rag.buildRetrievalQuestion({ question: 'what is a fraction', topic: '', history: [] })).toBe('what is a fraction');
  });

  test('a likely follow-up with prior user history -> prepends the previous question', () => {
    const history = [{ role: 'user', text: 'What is a fraction?' }, { role: 'assistant', text: 'A fraction is...' }];
    const result = rag.buildRetrievalQuestion({ question: 'give me another example', topic: '', history });
    expect(result).toContain('What is a fraction?');
    expect(result).toContain('Follow-up question: give me another example');
  });

  test('a likely follow-up but no prior user history -> question passes through unchanged', () => {
    expect(rag.buildRetrievalQuestion({ question: 'more examples please', topic: '', history: [] })).toBe('more examples please');
  });

  test('the "previous question" being identical to the current one is not treated as expandable', () => {
    const history = [{ role: 'user', text: 'more please' }];
    expect(rag.buildRetrievalQuestion({ question: 'more please', topic: '', history })).toBe('more please');
  });
});

describe('retrieveCurriculumContext (orchestration)', () => {
  test('a strong strict-topic match is used directly, broad search is never attempted', async () => {
    mockSearchContent.mockResolvedValueOnce([
      { score: 0.9, payload: { subject: 'Mathematics', topic: 'Fractions', text: 'fractions are parts of a whole', content_type: 'text' } },
    ]);

    const result = await rag.retrieveCurriculumContext({ question: 'What is a fraction?', curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Mathematics' });

    expect(result.meta.strategy).toBe('strict_topic');
    expect(result.context).toContain('fractions are parts of a whole');
    expect(mockSearchContent).toHaveBeenCalledTimes(1);
  });

  test('no strict-topic match -> falls back to a broader subject-only search', async () => {
    mockSearchContent
      .mockResolvedValueOnce([]) // strict
      .mockResolvedValueOnce([{ score: 0.3, payload: { subject: 'Mathematics', topic: 'Decimals', text: 'decimals content here' } }]); // broad

    const result = await rag.retrieveCurriculumContext({ question: 'unrelated phrasing entirely', curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Mathematics' });

    expect(result.meta.strategy).toBe('broad_subject');
    expect(mockSearchContent).toHaveBeenCalledTimes(2);
  });

  test('nothing found in either pass -> empty context, empty sources, no crash', async () => {
    mockSearchContent.mockResolvedValue([]);
    const result = await rag.retrieveCurriculumContext({ question: 'x', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(result.context).toBe('');
    expect(result.sources).toEqual([]);
  });

  test('subject not provided -> infers it from the question and reports subjectInferred: true', async () => {
    mockSearchContent.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await rag.retrieveCurriculumContext({ question: 'How do I add fractions?', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(result.meta.subjectUsed).toBe('Mathematics');
    expect(result.meta.subjectInferred).toBe(true);
  });

  test('subject explicitly provided -> subjectInferred is false', async () => {
    mockSearchContent.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await rag.retrieveCurriculumContext({ question: 'How do I add fractions?', curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Mathematics' });
    expect(result.meta.subjectInferred).toBe(false);
  });

  test('images are only included from high-confidence (>=0.30) results, even among the selected set', async () => {
    mockSearchContent.mockResolvedValueOnce([
      { score: 0.9, payload: { subject: 'Science', topic: 'Water Cycle', content_type: 'image', image_url: 'high-conf.png', text: 'evaporation diagram' } },
    ]);
    const result = await rag.retrieveCurriculumContext({ question: 'evaporation diagram', curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Science' });
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('high-conf.png');
  });
});

describe('retrieveNcertImages (orchestration)', () => {
  test('no question or topic -> returns [] immediately, no embed/search call', async () => {
    const result = await rag.retrieveNcertImages({ question: '', topic: '' });
    expect(result).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  test('a grade above 5 -> returns [] immediately (too advanced for NCERT primary fallback)', async () => {
    const result = await rag.retrieveNcertImages({ question: 'diagram', grade: 'Grade 8' });
    expect(result).toEqual([]);
    expect(mockSearchContent).not.toHaveBeenCalled();
  });

  test('a confident, caption-relevant match at grade 4 is returned', async () => {
    mockSearchContent.mockResolvedValueOnce([
      { score: 0.8, payload: { text: 'diagram of the water cycle evaporation stage', topic: 'Water Cycle', content_type: 'image', image_url: 'wc.png' } },
    ]);
    const result = await rag.retrieveNcertImages({ question: 'water cycle evaporation diagram', grade: 'Grade 4' });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('wc.png');
  });

  test('a match below the 0.65 confidence threshold is excluded from the strict pass', async () => {
    mockSearchContent
      .mockResolvedValueOnce([{ score: 0.5, payload: { text: 'water cycle evaporation stage', content_type: 'image', image_url: 'low-conf.png' } }])
      .mockResolvedValueOnce([]); // broad fallback also empty
    const result = await rag.retrieveNcertImages({ question: 'water cycle evaporation diagram', grade: 'Grade 4' });
    expect(result).toEqual([]);
  });

  test('a generic caption ("This image illustrates...") is filtered out even with a high score', async () => {
    mockSearchContent
      .mockResolvedValueOnce([{ score: 0.9, payload: { text: 'This image illustrates something', topic: 'water cycle', content_type: 'image', image_url: 'generic.png' } }])
      .mockResolvedValueOnce([]);
    const result = await rag.retrieveNcertImages({ question: 'water cycle diagram', grade: 'Grade 4' });
    expect(result).toEqual([]);
  });

  test('strict pass finds nothing -> falls back to a broader search with a higher score bar', async () => {
    mockSearchContent
      .mockResolvedValueOnce([]) // strict (subject/topic filtered)
      .mockResolvedValueOnce([{ score: 0.7, payload: { text: 'water cycle evaporation condensation', content_type: 'image', image_url: 'broad.png' } }]);
    const result = await rag.retrieveNcertImages({ question: 'water cycle evaporation diagram', grade: 'Grade 4' });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('broad.png');
  });

  test('results are capped at maxImages', async () => {
    mockSearchContent.mockResolvedValueOnce([
      { score: 0.9, payload: { text: 'water cycle evaporation diagram one', content_type: 'image', image_url: 'a.png' } },
      { score: 0.9, payload: { text: 'water cycle evaporation diagram two', content_type: 'image', image_url: 'b.png' } },
      { score: 0.9, payload: { text: 'water cycle evaporation diagram three', content_type: 'image', image_url: 'c.png' } },
    ]);
    const result = await rag.retrieveNcertImages({ question: 'water cycle evaporation diagram', grade: 'Grade 4', maxImages: 2 });
    expect(result).toHaveLength(2);
  });
});
