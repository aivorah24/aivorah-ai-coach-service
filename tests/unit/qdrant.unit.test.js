const mockSearch = jest.fn();
const mockGetCollections = jest.fn();
const mockCreateCollection = jest.fn();
const mockCreatePayloadIndex = jest.fn();
const mockUpsert = jest.fn();
const mockGetCollection = jest.fn();

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    search: (...args) => mockSearch(...args),
    getCollections: (...args) => mockGetCollections(...args),
    createCollection: (...args) => mockCreateCollection(...args),
    createPayloadIndex: (...args) => mockCreatePayloadIndex(...args),
    upsert: (...args) => mockUpsert(...args),
    getCollection: (...args) => mockGetCollection(...args),
  })),
}));

const qdrant = require('../../services/qdrant');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveCollection', () => {
  test('NCERT: routes to the NCERT collection, extracts a numeric grade', () => {
    const result = qdrant.resolveCollection('NCERT', 'Grade 6');
    expect(result).toEqual({ collection: qdrant.COLLECTION, qdrantCurriculum: 'NCERT', qdrantGrade: 6 });
  });

  test('NCERT: a plain numeric grade (already a number) passes through', () => {
    const result = qdrant.resolveCollection('NCERT', 7);
    expect(result.qdrantGrade).toBe(7);
  });

  test('NCERT: no grade -> qdrantGrade stays undefined/falsy, not a crash', () => {
    const result = qdrant.resolveCollection('NCERT', undefined);
    expect(result.qdrantGrade).toBeUndefined();
  });

  test('IB PYP: routes to the ai_mentor_content collection, curriculum becomes IB_PYP, grade becomes "Grade N"', () => {
    const result = qdrant.resolveCollection('IB PYP', '4');
    expect(result).toEqual({ collection: qdrant.IB_COLLECTION, qdrantCurriculum: 'IB_PYP', qdrantGrade: 'Grade 4' });
  });

  test('any other curriculum (e.g. CBSE) also routes to ai_mentor_content, curriculum unchanged', () => {
    const result = qdrant.resolveCollection('CBSE', 'Grade 6');
    expect(result).toEqual({ collection: qdrant.IB_COLLECTION, qdrantCurriculum: 'CBSE', qdrantGrade: 'Grade 6' });
  });
});

describe('searchContent', () => {
  test('builds a Qdrant filter only from the fields actually provided', async () => {
    mockSearch.mockResolvedValueOnce([{ id: 1 }]);
    await qdrant.searchContent({ vector: [0.1], curriculum: 'NCERT', grade: 6, limit: 3 });

    const [, options] = mockSearch.mock.calls[0];
    expect(options.filter.must).toEqual([
      { key: 'curriculum', match: { value: 'NCERT' } },
      { key: 'grade', match: { value: 6 } },
    ]);
  });

  test('no filter fields at all -> filter is undefined (not an empty must: [])', async () => {
    mockSearch.mockResolvedValueOnce([]);
    await qdrant.searchContent({ vector: [0.1] });
    const [, options] = mockSearch.mock.calls[0];
    expect(options.filter).toBeUndefined();
  });

  test('defaults to the NCERT collection when none is specified', async () => {
    mockSearch.mockResolvedValueOnce([]);
    await qdrant.searchContent({ vector: [0.1] });
    expect(mockSearch.mock.calls[0][0]).toBe(qdrant.COLLECTION);
  });
});

describe('searchGrounding — progressive fallback', () => {
  test('a strong match on the primary (native curriculum) attempt returns immediately', async () => {
    mockSearch.mockResolvedValueOnce([{ id: 'chunk-1' }]);
    const { chunks, source } = await qdrant.searchGrounding({ vector: [0.1], curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });

    expect(chunks).toEqual([{ id: 'chunk-1' }]);
    expect(source.curriculum).toBe('NCERT');
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  test('IB PYP with no native content falls back to its CBSE base standard', async () => {
    mockSearch
      .mockResolvedValueOnce([]) // primary: IB_PYP
      .mockResolvedValueOnce([{ id: 'cbse-chunk' }]); // fallback: CBSE base

    const { chunks, source } = await qdrant.searchGrounding({ vector: [0.1], curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Maths' });

    expect(chunks).toEqual([{ id: 'cbse-chunk' }]);
    expect(source.curriculum).toBe('CBSE');
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  test('IB PYP with no CBSE content either falls all the way back to NCERT base', async () => {
    mockSearch
      .mockResolvedValueOnce([]) // primary: IB_PYP
      .mockResolvedValueOnce([]) // CBSE base
      .mockResolvedValueOnce([{ id: 'ncert-chunk' }]); // NCERT base

    const { chunks, source } = await qdrant.searchGrounding({ vector: [0.1], curriculum: 'IB PYP', grade: 'Grade 4', subject: 'Maths' });

    expect(chunks).toEqual([{ id: 'ncert-chunk' }]);
    expect(source.curriculum).toBe('NCERT');
  });

  test('nothing ingested anywhere -> empty chunks, null source, no crash', async () => {
    mockSearch.mockResolvedValue([]);
    const { chunks, source } = await qdrant.searchGrounding({ vector: [0.1], curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });

    expect(chunks).toEqual([]);
    expect(source).toBeNull();
  });

  test('a Qdrant error on one attempt is swallowed and the next attempt is still tried', async () => {
    mockSearch
      .mockRejectedValueOnce(new Error('qdrant down'))
      .mockResolvedValueOnce([{ id: 'fallback-chunk' }]);

    const { chunks } = await qdrant.searchGrounding({ vector: [0.1], curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });

    expect(chunks).toEqual([{ id: 'fallback-chunk' }]);
  });
});
