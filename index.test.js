
const crawl = require('./index')

/* global test */
test('Get expiration for nitra.ai', async () => {
  await crawl('http://nitra.github.io/ru', 0, 2)
}, 30000)
