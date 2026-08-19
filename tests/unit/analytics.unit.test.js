jest.mock('../../services/supabase', () => {
  const chain = {
    insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { logEvent, readEvents, summarizeEvents } = require('../../services/analytics');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('logEvent', () => {
  test('inserts a real event row and returns it in camelCase', async () => {
    const result = await logEvent('ai_ask', { userEmail: 'A@A.com', role: 'student', status: 'success', latencyMs: 250 });

    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.event_type).toBe('ai_ask');
    expect(insertArg.user_email).toBe('a@a.com'); // normalized
    expect(result.eventType).toBe('ai_ask');
    expect(result.userEmail).toBe('a@a.com');
    expect(result.latencyMs).toBe(250);
  });

  test('a Supabase insert error -> returns null, does not throw', async () => {
    supabase._chain.insert.mockResolvedValueOnce({ error: new Error('insert failed') });
    const result = await logEvent('ai_ask', {});
    expect(result).toBeNull();
  });

  test('a thrown Supabase exception -> returns null, does not throw', async () => {
    supabase._chain.insert.mockRejectedValueOnce(new Error('db down'));
    const result = await logEvent('ai_ask', {});
    expect(result).toBeNull();
  });

  test('missing optional fields default sensibly (no undefined leaking into the row)', async () => {
    await logEvent('ai_ask', {});
    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.role).toBe('');
    expect(insertArg.latency_ms).toBeNull();
    expect(insertArg.score).toBeNull();
    expect(insertArg.meta).toEqual({});
  });
});

describe('readEvents (unused elsewhere in this repo — see dead-code note)', () => {
  test('maps rows to camelCase', async () => {
    supabase._chain.limit.mockResolvedValueOnce({
      data: [{ id: '1', event_type: 'ai_ask', timestamp: 't', user_email: 'a@a.com', latency_ms: 100, score: 3 }],
      error: null,
    });
    const result = await readEvents();
    expect(result[0]).toEqual(expect.objectContaining({ eventType: 'ai_ask', userEmail: 'a@a.com', latencyMs: 100, score: 3 }));
  });

  test('a Supabase error -> empty array', async () => {
    supabase._chain.limit.mockResolvedValueOnce({ data: null, error: new Error('db down') });
    expect(await readEvents()).toEqual([]);
  });
});

describe('summarizeEvents (pure, unused elsewhere in this repo — see dead-code note)', () => {
  test('counts total/success/failed AI events per event type', () => {
    const events = [
      { eventType: 'ai_ask', status: 'success', latencyMs: 100 },
      { eventType: 'ai_ask', status: 'success', latencyMs: 200 },
      { eventType: 'ai_ask', status: 'error' },
    ];
    const result = summarizeEvents(events);
    expect(result.aiMetrics).toEqual([
      { eventType: 'ai_ask', total: 3, success: 2, failed: 1, avgLatencyMs: 150 },
    ]);
  });

  test('feedback breakdown buckets scores into positive/neutral/negative', () => {
    const events = [
      { eventType: 'ai_feedback', score: 5 },
      { eventType: 'ai_feedback', score: 3 },
      { eventType: 'ai_feedback', score: 1 },
    ];
    const result = summarizeEvents(events);
    expect(result.feedback).toEqual({ total: 3, positive: 1, neutral: 1, negative: 1 });
  });

  test('unique users are tracked by most recent app_access/page_view event', () => {
    const events = [
      { eventType: 'app_access', userEmail: 'a@a.com', role: 'student', timestamp: '2024-01-01' },
      { eventType: 'page_view', userEmail: 'a@a.com', role: 'student', timestamp: '2024-01-02' },
    ];
    const result = summarizeEvents(events);
    expect(result.uniqueUsers).toBe(1);
    expect(result.usersLastSeen[0].lastSeen).toBe('2024-01-02');
  });

  test('empty events -> all-zero summary, no crash', () => {
    const result = summarizeEvents([]);
    expect(result.totalEvents).toBe(0);
    expect(result.aiMetrics).toEqual([]);
    expect(result.feedback).toEqual({ total: 0, positive: 0, neutral: 0, negative: 0 });
  });
});
