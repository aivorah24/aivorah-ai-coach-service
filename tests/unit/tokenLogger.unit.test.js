jest.mock('../../services/supabase', () => {
  const chain = {
    insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    select: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { logLLMCall, saveFeedback, getStats, estimateCost } = require('../../services/tokenLogger');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('estimateCost', () => {
  test('a known model computes input+output cost from real per-million-token pricing', () => {
    // llama-3.3-70b-versatile: input 0.59, output 0.79 per million tokens
    const cost = estimateCost('llama-3.3-70b-versatile', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.59 + 0.79, 5);
  });

  test('an unknown model -> 0, not a crash', () => {
    expect(estimateCost('some-unknown-model', 1000, 1000)).toBe(0);
  });

  test('zero tokens -> zero cost', () => {
    expect(estimateCost('llama-3.3-70b-versatile', 0, 0)).toBe(0);
  });
});

describe('logLLMCall', () => {
  test('inserts a real row with computed total_tokens and estimated_cost_usd', async () => {
    await logLLMCall({
      provider: 'groq', model: 'llama-3.1-8b-instant', route: '/ask', studentEmail: 'a@a.com',
      grade: 'Grade 4', subject: 'Maths', topic: 'Fractions',
      promptTokens: 100, completionTokens: 50, responseTimeMs: 1200, streamed: false,
    });

    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.total_tokens).toBe(150);
    expect(insertArg.estimated_cost_usd).toBeGreaterThan(0);
    expect(insertArg.student_email).toBe('a@a.com');
  });

  test('missing token counts default to 0, not undefined/NaN', async () => {
    await logLLMCall({ provider: 'nvidia', model: 'x', responseTimeMs: 100 });
    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.prompt_tokens).toBe(0);
    expect(insertArg.completion_tokens).toBe(0);
    expect(insertArg.total_tokens).toBe(0);
  });

  test('a Supabase failure is swallowed, not thrown (never breaks the main request)', async () => {
    supabase._chain.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(logLLMCall({ provider: 'groq', model: 'x' })).resolves.toBeUndefined();
  });
});

describe('saveFeedback', () => {
  test('updates the feedback column for the given log id', async () => {
    await saveFeedback('log-123', 3);
    expect(supabase._chain.update).toHaveBeenCalledWith({ feedback: 3 });
    expect(supabase._chain.eq).toHaveBeenCalledWith('id', 'log-123');
  });

  test('a Supabase failure is swallowed, not thrown', async () => {
    supabase._chain.eq.mockRejectedValueOnce(new Error('db down'));
    await expect(saveFeedback('log-123', 1)).resolves.toBeUndefined();
  });
});

describe('getStats (unused elsewhere in this repo — see dead-code note)', () => {
  test('returns the real rows from Supabase for the requested window', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [{ model: 'x' }], error: null });
    const result = await getStats({ days: 7 });
    expect(result).toEqual([{ model: 'x' }]);
  });

  test('a Supabase error -> empty array, not a crash', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: null, error: new Error('db down') });
    expect(await getStats()).toEqual([]);
  });
});
