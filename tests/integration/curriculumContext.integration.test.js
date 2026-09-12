const mockRetrieveCurriculumContext = jest.fn();
jest.mock('../../services/rag', () => ({
  retrieveCurriculumContext: (...args) => mockRetrieveCurriculumContext(...args),
}));

const request = require('supertest');
const express = require('express');
const curriculumContextRoute = require('../../routes/curriculumContext');

const app = express();
app.use(express.json());
app.use('/curriculum-context', curriculumContextRoute);

describe('POST /curriculum-context', () => {
  beforeEach(() => jest.clearAllMocks());

  test('passes through the retrieval result', async () => {
    mockRetrieveCurriculumContext.mockResolvedValueOnce({
      context: 'real ncert text', sources: [{ topic: 'Number line' }], images: [], meta: { strategy: 'strict_topic', selected: 1 },
    });

    const res = await request(app).post('/curriculum-context').send({
      question: 'Whole Numbers Number line', curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers',
    });

    expect(res.status).toBe(200);
    expect(res.body.context).toBe('real ncert text');
    expect(mockRetrieveCurriculumContext).toHaveBeenCalledWith({
      question: 'Whole Numbers Number line', curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers',
    });
  });

  test('400s when required fields are missing', async () => {
    const res = await request(app).post('/curriculum-context').send({ question: 'x' });
    expect(res.status).toBe(400);
    expect(mockRetrieveCurriculumContext).not.toHaveBeenCalled();
  });

  test('500s when retrieval throws', async () => {
    mockRetrieveCurriculumContext.mockRejectedValueOnce(new Error('qdrant down'));
    const res = await request(app).post('/curriculum-context').send({ question: 'x', curriculum: 'CBSE', grade: '6' });
    expect(res.status).toBe(500);
  });
});
