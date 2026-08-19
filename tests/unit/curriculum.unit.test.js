const { normalizeCurriculum } = require('../../utils/curriculum');

describe('normalizeCurriculum', () => {
  test.each([
    ['IB_PYP', 'IB PYP'],
    ['IB PYP', 'IB PYP'],
    ['IBPYP', 'IB PYP'],
    ['ib pyp', 'IB PYP'],
    ['ib_pyp', 'IB PYP'],
    ['NCERT', 'NCERT'],
    ['ncert', 'NCERT'],
    ['CBSE', 'NCERT'],
    ['cbse', 'NCERT'],
    ['Cbse', 'NCERT'],
    ['Cambridge', 'Cambridge'],
    ['Oxford', 'Oxford'],
    ['Pearson', 'Pearson'],
    ['Singapore MOE', 'Singapore MOE'],
    ['Singapore_MOE', 'Singapore MOE'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCurriculum(input)).toBe(expected);
  });

  test('ICSE and NIOS map to their own distinct canonical names, not NCERT', () => {
    expect(normalizeCurriculum('ICSE')).toBe('ICSE');
    expect(normalizeCurriculum('icse')).toBe('ICSE');
    expect(normalizeCurriculum('NIOS')).toBe('NIOS');
    expect(normalizeCurriculum('nios')).toBe('NIOS');
  });

  test('an unrecognized curriculum string passes through unchanged (not silently mapped)', () => {
    expect(normalizeCurriculum('Some Other Board')).toBe('Some Other Board');
  });

  test('no curriculum given -> falls back to "IB PYP" by default', () => {
    expect(normalizeCurriculum(undefined)).toBe('IB PYP');
    expect(normalizeCurriculum(null)).toBe('IB PYP');
    expect(normalizeCurriculum('')).toBe('IB PYP');
  });

  test('a custom fallback is honored when no curriculum is given', () => {
    expect(normalizeCurriculum(undefined, 'NCERT')).toBe('NCERT');
  });

  test('surrounding whitespace is trimmed before matching', () => {
    expect(normalizeCurriculum('  CBSE  ')).toBe('NCERT');
  });
});
