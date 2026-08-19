jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { getLessonGrounding } = require('../../services/ai-coach/lessonGrounding');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getLessonGrounding', () => {
  test('no topic -> empty string, no Supabase call', async () => {
    expect(await getLessonGrounding('')).toBe('');
    expect(await getLessonGrounding(undefined)).toBe('');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('topic not found in syllabus_topics -> empty string', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null });
    expect(await getLessonGrounding('Some Unknown Topic')).toBe('');
  });

  test('topic found but no AI_EXPLANATION resource -> empty string', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'topic-1' } }) // syllabus_topics
      .mockResolvedValueOnce({ data: null }); // topic_resources
    expect(await getLessonGrounding('Fractions')).toBe('');
  });

  test('a resource with no static_payload -> empty string', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'topic-1' } })
      .mockResolvedValueOnce({ data: { static_payload: null } });
    expect(await getLessonGrounding('Fractions')).toBe('');
  });

  test('a lesson with only body text -> returns it, no worked-examples header', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'topic-1' } })
      .mockResolvedValueOnce({ data: { static_payload: { body: ['A fraction is a part of a whole.'] } } });

    const result = await getLessonGrounding('Fractions');

    expect(result).toContain('A fraction is a part of a whole.');
    expect(result).not.toContain('Worked examples');
  });

  test('a lesson with worked examples includes the problem, steps, and answer, with the anti-drift instruction', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'topic-1' } })
      .mockResolvedValueOnce({
        data: {
          static_payload: {
            body: ['Subtraction basics.'],
            workedExamples: [{ problem: '45 - 3', steps: ['Line up the digits', 'Subtract'], answer: '42' }],
          },
        },
      });

    const result = await getLessonGrounding('Subtraction');

    expect(result).toContain('AUTHORITATIVE LESSON CONTENT for "Subtraction"');
    expect(result).toContain('do not invent another method or miscalculate');
    expect(result).toContain('45 - 3 → Line up the digits Subtract Answer: 42.');
  });

  test('a Supabase error -> empty string, not a crash', async () => {
    supabase._chain.maybeSingle.mockRejectedValueOnce(new Error('db down'));
    expect(await getLessonGrounding('Fractions')).toBe('');
  });
});
