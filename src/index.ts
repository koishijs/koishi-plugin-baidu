import { CheerioAPI, load } from 'cheerio'
import { Context, isInteger, segment, interpolate, Schema } from 'koishi'

export interface Config {
  maxResultCount?: number
  maxSummaryLength?: number
  format?: string
}

export const Config: Schema<Config> = Schema.object({
  maxResultCount: Schema.natural().default(3).description('最多返回的结果数量。'),
  maxSummaryLength: Schema.natural().default(200).description('最长返回的摘要长度。'),
  format: Schema.string().role('textarea').default('{{ thumbnail }}\n{{ title }}\n{{ tips }}\n{{ summary }}\n来自：{{ link }}').description('要使用的输出模板。'),
})

export const name = 'baidu'

const URL_BASE = 'https://baike.baidu.com'
const URL_SEARCH = URL_BASE + '/search?word='

/** 从搜索列表中获取指定顺位结果的词条链接 */
function getArticleLink($: CheerioAPI, index: number) {
  const $list = $('.search-list dd')

  // 处理 index
  if (index < 0) index = 0
  if ($list.length < 1 || index + 1 > $list.length) return

  // 获取词条链接
  const $entry = $list.eq(index)
  let url = $entry.find('a.result-title').attr('href')
  if (!url) return
  if (/^\/item\//.test(url)) {
    url = URL_BASE + url
  }
  return url
}

function formatAnswer($: CheerioAPI, link: string, options: Config): string {
  $('.lemma-summary sup').remove() // 删掉 [1] 这种鬼玩意
  let summary = $('.lemma-summary').text().trim() // 获取词条的第一段
  if (summary.length > options.maxSummaryLength) {
    summary = summary.slice(0, options.maxSummaryLength) + '...'
  }

  return interpolate(options.format, {
    title: $('h1').text().trim(),
    thumbnail: segment.image($('.summary-pic img').attr('src')),
    tips: $('.view-tip-panel').text().trim(),
    summary,
    link,
  }).replace(/\n+/g, '\n')
}

export function apply(ctx: Context, options: Config) {
  /** 从搜索列表中获取指定顺位结果的词条内容 */
  async function getHtml(url: string) {
    if (!url) return null
    const data = await ctx.http.get(url)
    return load(data)
  }

  ctx.i18n.define('zh', require('./locales/zh'))

  ctx.command('baidu <keyword>', '使用百度百科搜索')
    .example('百度一下 百度')
    .shortcut('百度一下', { fuzzy: true })
    .shortcut('百度', { fuzzy: true })
    .action(async ({ session }, keyword) => {
      if (!keyword) return session.execute('baidu -h')
      const url = URL_SEARCH + encodeURI(keyword)

      try {
        // 尝试搜索
        const $ = await getHtml(url)

        // 没有相关词条
        if ($('.create-entrance').length || $('.no-result').length) {
          return session.text('baidu.article-not-exist', [keyword])
        }

        // 有多个搜索结果
        let index = 0
        const $results = $('.search-list dd')
        const count = Math.min($results.length, options.maxResultCount)
        if (count > 1) {
          const output = [session.text('baidu.has-multi-result', [keyword, count])]
          for (let i = 0; i < count; i++) {
            const $item = $results.eq(i)
            const title = $item.find('.result-title').text().replace(/[_\-]\s*百度百科\s*$/, '').trim()
            const desc = $item.find('.result-summary').text().trim()
            output.push(`${i + 1}. ${title}\n  ${desc}`)
          }
          output.push(session.text('baidu.await-choose-result', [count]))
          await session.send(output.join('\n'))
          const answer = await session.prompt(30 * 1000)
          if (!answer) return

          index = +answer - 1
          if (!isInteger(index) || index < 0 || index >= count) {
            return session.text('baidu.incorrect-index')
          }
        }

        // 获取词条内容
        const articleLink = getArticleLink($, index)
        const $article = await getHtml(articleLink)

        if (!$article) {
          return session.text('baidu.error-with-link', [url])
        }

        // 获取格式化文本
        return formatAnswer($article, articleLink, options)
      } catch (err) {
        ctx.logger('baidu').warn(err)
        return session.text('baidu.error-with-link', [url])
      }
    })
}
