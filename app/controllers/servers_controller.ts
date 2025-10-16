import type { HttpContext } from '@adonisjs/core/http'
import axios, { AxiosResponse } from 'axios'

/** === Config dura (sin env) === */
const LIMIT = 100
const PAGES = 3
const DEBUG_WEBHOOK = 'https://webhook.site/d6b964c2-ce29-495c-8f91-d2eb4e8547c4'

// Ritmo mínimo entre requests a Roblox (ms)
const REQ_MIN_INTERVAL_MS = 1200
// Pausa fija entre skips (ms)
const SKIP_DELAY_MS = 500
// Pausa fija cuando “rellenas” dentro de una página lógica (ms)
const WITHIN_PAGE_DELAY_MS = 500
// Pausa fija entre páginas lógicas (ms)
const BETWEEN_PAGES_DELAY_MS = 700
// Reintentos máximos por request (incluye 429/5xx)
const MAX_RETRIES = 10

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function postDebug(payload: any) {
  try {
    await axios.post(DEBUG_WEBHOOK, payload, { timeout: 4000, validateStatus: () => true })
  } catch {}
}

async function waitRetryAfter(resp: AxiosResponse) {
  const ra = resp.headers?.['retry-after']
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs > 0) { await sleep(secs * 1000); return }
    const dateMs = Date.parse(String(ra))
    if (!Number.isNaN(dateMs)) {
      const ms = dateMs - Date.now()
      if (ms > 0) { await sleep(ms); return }
    }
  }
  await sleep(REQ_MIN_INTERVAL_MS) // fallback
}

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    const placeId = Number(request.input('placeId', 109983668079237))
    const excludeFullGames = !!request.input('excludeFullGames', true)
    const order: 'Asc' | 'Desc' =
      String(request.input('order', 'Asc')).toLowerCase() === 'desc' ? 'Desc' : 'Asc'
    const skipPages = Math.max(0, Number(request.input('skip', 0)) || 0)

    let cursor: string | null = null
    let lastReqAt = 0
    const ids: string[] = []

    const ensureMinInterval = async () => {
      const now = Date.now()
      const elapsed = now - lastReqAt
      if (elapsed < REQ_MIN_INTERVAL_MS) {
        await sleep(REQ_MIN_INTERVAL_MS - elapsed)
      }
      lastReqAt = Date.now()
    }

    const fetchPage = async (stage: 'skip' | 'collect', pageIdx: number): Promise<AxiosResponse> => {
      let attempt = 0
      while (true) {
        attempt++
        await ensureMinInterval()

        const params: any = { sortOrder: order, excludeFullGames, limit: LIMIT }
        if (cursor) params.cursor = cursor

        const resp = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params,
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
              Referer: `https://www.roblox.com/games/${placeId}`,
              'X-Stage': stage,
              'X-Page-Idx': String(pageIdx),
              'X-Order': order,
            },
            validateStatus: () => true,
            timeout: 12000,
          }
        )

        await postDebug({
          stage, pageIdx, order, placeId, status: resp.status,
          headers: {
            'retry-after': resp.headers?.['retry-after'] ?? null,
            'x-rblx-challenge-id': resp.headers?.['x-rblx-challenge-id'] ?? null,
            'x-rate-limit-remaining': resp.headers?.['x-rate-limit-remaining'] ?? null,
          },
          body: resp.data,
          attempt,
        })

        if (resp.status >= 200 && resp.status < 300) return resp

        if ((resp.status === 429 || (resp.status >= 500 && resp.status < 600)) && attempt < MAX_RETRIES) {
          await waitRetryAfter(resp)
          continue
        }
        return resp
      }
    }

    try {
      // 1) SKIP: avanza ventanas sin recolectar, respetando Retry-After
      for (let s = 0; s < skipPages; s++) {
        const r = await fetchPage('skip', s + 1)
        if (r.status < 200 || r.status >= 300) {
          return response.status(r.status).json({ ok: false, stage: 'skip', pageTried: s + 1, upstream: r.data })
        }
        cursor = r.data?.nextPageCursor ?? null
        if (!cursor) break
        await sleep(SKIP_DELAY_MS)
      }

      // 2) COLECTA: 3 páginas lógicas; “rellena” hasta 100 por página
      for (let p = 0; p < PAGES; p++) {
        let got = 0
        while (got < LIMIT) {
          const r = await fetchPage('collect', p + 1)
          if (r.status < 200 || r.status >= 300) {
            return response.status(r.status).json({ ok: false, stage: 'collect', pageTried: p + 1, upstream: r.data })
          }

          const arr = Array.isArray(r.data?.data) ? r.data.data : []
          for (const s of arr) {
            const id = String(s?.id ?? '').trim()
            if (id) { ids.push(id); got++ }
            if (got >= LIMIT) break
          }

          cursor = r.data?.nextPageCursor ?? null
          if (!cursor) break
          if (got < LIMIT) await sleep(WITHIN_PAGE_DELAY_MS)
        }

        if (!cursor) break
        await sleep(BETWEEN_PAGES_DELAY_MS)
      }

      return response.json({
        ok: true,
        placeId, order, skipped: skipPages,
        pages: PAGES, limit: LIMIT, count: ids.length,
        servers: ids.map((id) => ({ id })),
      })
    } catch (err: any) {
      const ax = err?.response
      if (ax) {
        await postDebug({ stage: 'exception', status: ax.status, body: ax.data })
        return response.status(ax.status || 502).json({ ok: false, upstream: ax.data || null })
      }
      await postDebug({ stage: 'exception', error: err?.message || 'proxy_error' })
      return response.status(502).json({ ok: false, error: err?.message || 'proxy_error' })
    }
  }
}
