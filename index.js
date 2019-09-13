/**
 * Кравлер
 *
 * @module @nitra/crawler
 */
const log = require('loglevel-colored-level-prefix')()

const fetch = require('node-fetch')
const puppeteer = require('puppeteer')

const catchedErrors = []
const mapLinks = new Map()

// TODO: respect robots.txt
// https://www.promptcloud.com/blog/how-to-read-and-respect-robots-file/

/**
 * Кравлер
 * @param {String} target - Стартова сторінка
 * @param {Number} waitSeconds - Пауза між скануваннями сторінок в мілісекундах
 * @param {Number} limit - Не більше заданої кількості сторінок сканувати
 *
 * @return {Promise<Array>} Список знайдених помилок
 */
async function crawl (target, waitSeconds = 0, limit = 1000) {
  const host = new URL(target).host
  if (!host) {
    throw new Error(`not valid url: ${target}`)
  }

  const externalLinks = new Map()
  const visitedUrls = new Set()

  // Додаємо в список урл для аналізу - першу сторінку
  mapLinks.set(target, 'start')

  const puppeteerOptions = {
    // TODO: прибрати помилку без --no-sandbox
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  }

  // Якщо в контейнері
  if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD) {
    puppeteerOptions.executablePath = '/usr/bin/chromium-browser'
  }

  const browser = await puppeteer.launch(puppeteerOptions)
  const page = await browser.newPage()

  // Закриваємо всі діалогові вікна - http://glass-poltava.com.ua/
  page.on('dialog', async dialog => {
    log.debug('dialog.dismissed')
    await dialog.dismiss()
  })

  // Фіксуємо всі записи в консолі
  page.on('console', mes => {
    // @ts-ignore
    if (mes._type !== 'log') {
      catchedErrors.push({
        // @ts-ignore
        type: mes._type,
        text:
          // @ts-ignore
          mes._text + ' ' + mes._location.url + ' ' + mes._location.lineNumber,
        url: target,
        name: mapLinks.get(target)
      })
    }
  })

  try {
  // Якщо є наступна сторінка для сканування, та не перевищили ліміт (за умовчанням 1000 сторінок)
    let i = 1
    while (
      visitedUrls.size < limit &&
    (target = nonVisitedUrl(visitedUrls, mapLinks))
    ) {
      log.debug(`Page ${i++} : ${target} "${mapLinks.get(target)}"`)
      visitedUrls.add(target)

      // Якщо необхідно робити паузи
      // та це не перша сторінка
      if (waitSeconds && visitedUrls.size !== 1) {
        log.debug(`pause for ${waitSeconds / 1000} seconds`)
        await page.waitFor(waitSeconds)
      }

      let response
      try {
        response = await page.goto(target, {
          waitUntil: 'networkidle2'
        })
      } catch (err) {
      // Якщо в якості урл, йде завантаження файлу. то йдему на наступну сторінку
        log.debug(err)
        continue
      }

      // Додаємо отриманий урл після редиректу до списку вже проаналізованих
      visitedUrls.add(response.url())
      log.debug(`Фактичний url: ${response.url()}`)

      // Якшо статус не 200
      // відмічаємо
      if (response.status() !== 200) {
        catchedErrors.push({
          type: 'statusCode',
          text: `code is: ${response.status()}`,
          url: target,
          name: mapLinks.get(target)
        })
      }

      // Find all links
      const linksArray = await page.evaluate(() => {
      // все ссылки на странице формируем в массив обьектов с href и текстом ссылки
        const linksArray = Array.from(document.querySelectorAll('a')).map(
          link => {
            return { href: link.href, text: link.text.trim() }
          }
        )

        // добавляем в массив ссылок meta с отложенным редиректом если есть (<meta http-equiv="refresh" content="55; url=http://nitra.github.io/ru" />)
        /**
       * @type {HTMLMetaElement}
       */
        const meta = document.querySelector('meta[http-equiv=refresh]')
        if (meta && meta.content) {
          linksArray.push({
            href: meta.content.substring(meta.content.indexOf('http')),
            text: 'meta-refresh'
          })
        }

        return linksArray
      })

      // Готовим ссылки для дальнейшей записи:
      for (const link of linksArray) {
      // 1. отрезаем якоря из ссылки https://nitra.ai/#scanner => https://nitra.ai/
        let href = link.href
        if (href.indexOf('#') !== -1) {
          href = href.substr(0, href.indexOf('#'))
        }
        if (!href) {
          continue
        }

        // 2. Залишаємо тільки HTTP/s (без mailto, ftp, ...)
        const pLink = new URL(href)
        if (!pLink.protocol.startsWith('http')) {
          log.debug(`Other protocol: ${href}`)
          continue
        }

        // 3. ті, які не ссилаються на аналізуємий домен
        // перевіряємо що не 404, 50х
        if (pLink.host !== host) {
          externalLinks.set(href, `${target} -> ${link.text}`)
          log.debug(`External link: ${href}`)
          continue
        }

        // 4. Додаємо до списка посилань, тільки ті яких там ще немає
        if (!mapLinks.has(href)) {
          mapLinks.set(href, link.text)
        }
      }
    }
  } catch (err) {
    log.error(err)
  } finally {
    await browser.close()
  }

  // Якщо є зовнішні посилання на перевірку
  if (externalLinks.size > 0) {
    try {
      // Результат записується в catchedErrors
      await externalCheck(externalLinks)
    } catch (err) {
      log.error(err)
    }
  }

  return catchedErrors
}

/**
 * Пошук сторінок - які ще не відвідували
 *
 * @param {Set} visitedUrls - Набір посилань які вже відвідали
 * @param {Map} mapLinks - Знайдені на сторінкі посилання
 *
 * @return {String} Сторінка яку ще не відвідали, а треба відвідати
 */
function nonVisitedUrl (visitedUrls, mapLinks) {
  const nonVisitedUrls = []
  for (const key of mapLinks.keys()) {
    if (!visitedUrls.has(key)) {
      nonVisitedUrls.push(key)
    }
  }
  if (nonVisitedUrls.length === 0) {
    return null
  }

  // Випадкове посилання зі списку
  return nonVisitedUrls[Math.floor(Math.random() * nonVisitedUrls.length)]
}

/**
 * Перевірка посилань на доступність
 *
 * @param {Map} externalLinks - Набір посилань для перевірки
 */
async function externalCheck (externalLinks) {
  for (const [link, name] of externalLinks) {
    // @ts-ignore
    const getExternal = await fetch(link)

    if (getExternal.status > 403) {
      catchedErrors.push({
        type: 'externalCheck',
        text: `code is: ${getExternal.status}`,
        url: link,
        name: name
      })
    }

    log.debug(`get resopnse code: ${getExternal.status} for external: ${link}`)
  }
}

// Export it to make it available outside
module.exports = crawl
