const { retrieveWebContext, retrieveWebImages, buildCurriculumSearchQuery } = require('../../services/webSearch');

function mockFetchByUrl(handlers) {
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (u.includes('prop=imageinfo') && handlers.imageinfo) return handlers.imageinfo();
    if (u.includes('prop=images') && handlers.images) return handlers.images();
    if (u.includes('list=search') && handlers.search) return handlers.search();
    if (u.includes('/page/summary/') && handlers.summary) return handlers.summary();
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.WEB_SEARCH_FALLBACK;
  delete global.fetch;
});

describe('buildCurriculumSearchQuery', () => {
  test('joins topic, question, subject, grade, and curriculum (underscores replaced) with a school-students suffix', () => {
    const query = buildCurriculumSearchQuery({ question: 'What is a fraction?', curriculum: 'IB_PYP', grade: 'Grade 4', subject: 'Mathematics', topic: 'Fractions' });
    expect(query).toBe('Fractions What is a fraction? Mathematics Grade 4 IB PYP for school students');
  });

  test('missing fields are simply omitted, not left as blank/undefined tokens', () => {
    const query = buildCurriculumSearchQuery({ question: 'What is a fraction?' });
    expect(query).toBe('What is a fraction? for school students');
  });
});

describe('retrieveWebContext', () => {
  test('WEB_SEARCH_FALLBACK=false -> disabled, no fetch attempted', async () => {
    process.env.WEB_SEARCH_FALLBACK = 'false';
    const result = await retrieveWebContext({ question: 'What is a fraction?' });
    expect(result).toEqual({ context: '', sources: [], meta: { enabled: false, query: '', count: 0 } });
    expect(global.fetch).toBeUndefined();
  });

  test('enabled by default (no env var set) -> searches Wikipedia and returns formatted context + sources', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Fraction (mathematics)', snippet: 'snip' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ extract: 'A fraction represents a part of a whole.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Fraction' } } }) }),
    });

    const result = await retrieveWebContext({ question: 'What is a fraction?', curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });

    expect(result.meta.enabled).toBe(true);
    expect(result.meta.count).toBe(1);
    expect(result.context).toContain('[Web > Wikipedia > Fraction (mathematics)]');
    expect(result.context).toContain('A fraction represents a part of a whole.');
    expect(result.sources[0]).toEqual({ subject: 'Web', unit: 'Wikipedia', topic: 'Fraction (mathematics)', score: 0.5, url: 'https://en.wikipedia.org/wiki/Fraction' });
  });

  test('a failed search request -> empty context, no crash', async () => {
    mockFetchByUrl({ search: () => Promise.resolve({ ok: false }) });
    const result = await retrieveWebContext({ question: 'x' });
    expect(result.context).toBe('');
    expect(result.meta.count).toBe(0);
  });

  test('no search results at all -> empty context, count 0', async () => {
    mockFetchByUrl({ search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [] } }) }) });
    const result = await retrieveWebContext({ question: 'x' });
    expect(result.context).toBe('');
    expect(result.meta.count).toBe(0);
  });

  test('a summary fetch failing for one hit is skipped, not fatal to the whole request', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Article A' }, { title: 'Article B', snippet: 'fallback snippet' }] } }) }),
      summary: jest.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ extract: '' }) }), // falls back to item.snippet
    });

    const result = await retrieveWebContext({ question: 'x' });

    expect(result.meta.count).toBe(1);
    expect(result.context).toContain('fallback snippet');
  });

  test('HTML tags in the extract are stripped from the final snippet', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Article A' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ extract: '<b>Bold</b> text <i>here</i>' }) }),
    });
    const result = await retrieveWebContext({ question: 'x' });
    expect(result.context).toContain('Bold text here');
    expect(result.context).not.toContain('<b>');
  });
});

describe('retrieveWebImages (currently unused elsewhere in the codebase — see dead-code note)', () => {
  test('no topic or question -> returns [] immediately, no fetch attempted', async () => {
    const result = await retrieveWebImages({ question: '', topic: '' });
    expect(result).toEqual([]);
    expect(global.fetch).toBeUndefined();
  });

  test('no search candidates found -> []', async () => {
    mockFetchByUrl({ search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [] } }) }) });
    expect(await retrieveWebImages({ topic: 'Water Cycle' })).toEqual([]);
  });

  test('every candidate article fails educational validation -> []', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Some Movie' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ description: '2019 american superhero film', type: 'standard' }) }),
    });
    expect(await retrieveWebImages({ topic: 'Some Movie' })).toEqual([]);
  });

  test('a disambiguation page is rejected even without a matching blocklist description', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Mercury' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ description: 'may refer to', type: 'disambiguation' }) }),
    });
    expect(await retrieveWebImages({ topic: 'Mercury' })).toEqual([]);
  });

  test('an educational article with a real, safe image -> returns it with a cleaned caption', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Water cycle' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ description: 'process describing water movement', type: 'standard' }) }),
      images: () => Promise.resolve({ ok: true, json: async () => ({ query: { pages: { '1': { images: [{ title: 'File:Water_cycle_diagram.jpg' }] } } } }) }),
      imageinfo: () => Promise.resolve({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'File:Water_cycle_diagram.jpg',
                imageinfo: [{ thumburl: 'https://upload.wikimedia.org/thumb.jpg', width: 400, height: 300, extmetadata: { ImageDescription: { value: 'A diagram of the water cycle' } } }],
              },
            },
          },
        }),
      }),
    });

    const result = await retrieveWebImages({ topic: 'water cycle' });

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://upload.wikimedia.org/thumb.jpg');
    expect(result[0].caption).toBe('A diagram of the water cycle');
  });

  test('images too small (icons) are excluded', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Water cycle' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ description: 'a natural process', type: 'standard' }) }),
      images: () => Promise.resolve({ ok: true, json: async () => ({ query: { pages: { '1': { images: [{ title: 'File:icon_small.jpg' }] } } } }) }),
      imageinfo: () => Promise.resolve({
        ok: true,
        json: async () => ({ query: { pages: { '1': { title: 'File:icon_small.jpg', imageinfo: [{ thumburl: 'x.jpg', width: 50, height: 50 }] } } } }),
      }),
    });
    expect(await retrieveWebImages({ topic: 'water cycle' })).toEqual([]);
  });

  test('a technical/advanced-term caption is excluded even from an otherwise valid image', async () => {
    mockFetchByUrl({
      search: () => Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: 'Photosynthesis' }] } }) }),
      summary: () => Promise.resolve({ ok: true, json: async () => ({ description: 'biological process in plants', type: 'standard' }) }),
      images: () => Promise.resolve({ ok: true, json: async () => ({ query: { pages: { '1': { images: [{ title: 'File:calvin_cycle.jpg' }] } } } }) }),
      imageinfo: () => Promise.resolve({
        ok: true,
        json: async () => ({
          query: { pages: { '1': { title: 'File:calvin_cycle.jpg', imageinfo: [{ thumburl: 'x.jpg', width: 400, height: 300, extmetadata: { ImageDescription: { value: 'Diagram of the calvin cycle' } } }] } } },
        }),
      }),
    });
    expect(await retrieveWebImages({ topic: 'photosynthesis' })).toEqual([]);
  });

  test('a network failure anywhere in the pipeline is caught -> []', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    expect(await retrieveWebImages({ topic: 'water cycle' })).toEqual([]);
  });
});
