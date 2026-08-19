// embed() lazy-requires @xenova/transformers inside the function body (to
// avoid crashing serverless cold starts), so we mock that module and let
// Jest's module registry intercept the lazy require the same as a top-level one.

const mockPipelineFn = jest.fn();
const mockPipelineFactory = jest.fn().mockResolvedValue(mockPipelineFn);
jest.mock('@xenova/transformers', () => ({
  pipeline: (...args) => mockPipelineFactory(...args),
}), { virtual: true });

describe('embed', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('loads the embedding pipeline once and returns a plain array from the tensor output', async () => {
    mockPipelineFn.mockResolvedValueOnce({ data: new Float32Array([0.1, 0.2, 0.3]) });
    const { embed } = require('../../services/embeddings');

    const result = await embed('What is a fraction?');

    expect(mockPipelineFactory).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.2);
    expect(result[2]).toBeCloseTo(0.3);
  });

  test('trims the input text before embedding it', async () => {
    mockPipelineFn.mockResolvedValueOnce({ data: new Float32Array([1]) });
    const { embed } = require('../../services/embeddings');

    await embed('  hello world  ');

    expect(mockPipelineFn).toHaveBeenCalledWith('hello world', { pooling: 'mean', normalize: true });
  });

  test('the embedding model is loaded only once across multiple embed() calls', async () => {
    mockPipelineFn.mockResolvedValue({ data: new Float32Array([1]) });
    const { embed } = require('../../services/embeddings');

    await embed('first question');
    await embed('second question');

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });
});
