// cloudinaryUrls.js loads its map from fs at require-time (module-scope
// side effect) and sets up an fs.watch — mock fs before each fresh require.

jest.mock('fs');

function freshCloudinaryUrls(mapContents) {
  jest.resetModules();
  const fs = require('fs');
  fs.existsSync = jest.fn().mockReturnValue(mapContents !== null);
  fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(mapContents || {}));
  fs.watch = jest.fn();
  return require('../../services/cloudinaryUrls');
}

describe('resolveImageUrl', () => {
  test('no path given -> null', () => {
    const { resolveImageUrl } = freshCloudinaryUrls({});
    expect(resolveImageUrl(null)).toBeNull();
    expect(resolveImageUrl('')).toBeNull();
  });

  test('a path present in the map -> returns the Cloudinary CDN URL', () => {
    const { resolveImageUrl } = freshCloudinaryUrls({ 'ncert/grade3/cemm101_page1.png': 'https://cdn.cloudinary.com/abc123.png' });
    expect(resolveImageUrl('/data/images/ncert/grade3/cemm101_page1.png')).toBe('https://cdn.cloudinary.com/abc123.png');
  });

  test('a path NOT in the map -> falls back to the original local path unchanged', () => {
    const { resolveImageUrl } = freshCloudinaryUrls({});
    expect(resolveImageUrl('/data/images/ncert/grade3/unmapped.png')).toBe('/data/images/ncert/grade3/unmapped.png');
  });

  test('backslash-style Windows paths are normalized before lookup', () => {
    const { resolveImageUrl } = freshCloudinaryUrls({ 'ncert/grade3/cemm101_page1.png': 'https://cdn.cloudinary.com/abc123.png' });
    expect(resolveImageUrl('data\\images\\ncert\\grade3\\cemm101_page1.png')).toBe('https://cdn.cloudinary.com/abc123.png');
  });

  test('no map file on disk -> every path falls back to the original local path, no crash', () => {
    const { resolveImageUrl } = freshCloudinaryUrls(null);
    expect(resolveImageUrl('/data/images/x.png')).toBe('/data/images/x.png');
  });

  test('a corrupt map file -> falls back to an empty map, no crash', () => {
    jest.resetModules();
    const fs = require('fs');
    fs.existsSync = jest.fn().mockReturnValue(true);
    fs.readFileSync = jest.fn().mockReturnValue('{ not valid json');
    fs.watch = jest.fn();
    const { resolveImageUrl } = require('../../services/cloudinaryUrls');
    expect(resolveImageUrl('/data/images/x.png')).toBe('/data/images/x.png');
  });
});
