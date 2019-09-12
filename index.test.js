  
const crawl = require('./index')

/* global test, expect */
test('Get expiration for nitra.ai', async () => {
    await crawl('http://nitra.github.io/ru')
}, 30000)
