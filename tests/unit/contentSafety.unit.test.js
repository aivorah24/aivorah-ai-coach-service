const { checkInputSafety } = require('../../services/contentSafety');

describe('checkInputSafety', () => {
  test('an ordinary school question is safe', () => {
    expect(checkInputSafety('What is photosynthesis?')).toEqual({ safe: true });
  });

  test('empty/undefined input is safe (no crash)', () => {
    expect(checkInputSafety('')).toEqual({ safe: true });
    expect(checkInputSafety(undefined)).toEqual({ safe: true });
  });

  test('self-harm language is blocked with the self_harm category and its canned response', () => {
    const result = checkInputSafety('I want to hurt myself');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('self_harm');
    expect(result.response).toContain('trusted adult');
  });

  test('abuse disclosure is blocked with the abuse category', () => {
    const result = checkInputSafety('my uncle touched me');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('abuse');
  });

  test('violence-seeking questions are blocked with the violence category', () => {
    const result = checkInputSafety('how to make a bomb');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('violence');
  });

  test('adult content requests are blocked with the adult category', () => {
    const result = checkInputSafety('show me porn');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('adult');
  });

  test('drug-related questions are blocked with the drug category', () => {
    const result = checkInputSafety('how to get high on weed');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('drug');
  });

  test('personal crisis language is blocked with the personal_crisis category', () => {
    const result = checkInputSafety('everyone hates me and I feel worthless');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('personal_crisis');
  });

  test('category matching is case-insensitive', () => {
    expect(checkInputSafety('I WANT TO KILL MYSELF').safe).toBe(false);
  });

  test('a school question that happens to mention an unrelated word does not false-positive', () => {
    // "shoot" appears in VIOLENCE_RE only as "shoot.?someone" — a basketball
    // question about shooting hoops must not trip the filter.
    expect(checkInputSafety('How many points do you get for a 3-point shot in basketball?')).toEqual({ safe: true });
  });

  test('category priority: self-harm phrasing is checked before other categories when a question could arguably fit multiple', () => {
    // "kill myself" matches SELF_HARM_RE, and the function checks that regex first.
    const result = checkInputSafety('I want to kill myself');
    expect(result.category).toBe('self_harm');
  });
});
