// app/controllers/servers_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import axios, { AxiosResponse } from 'axios'

// === Webhook de depuración (fijo) ===
const DEBUG_WEBHOOK = 'https://webhook.site/d6b964c2-ce29-495c-8f91-d2eb4e8547c4'

// Fire-and-forget para no bloquear el flujo si falla el webhook
async function postDebug(payload: any) {
  try {
    await axios.post(DEBUG_WEBHOOK, payload, { timeout: 4000, validateStatus: () => true })
  } catch {}
}

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    // Forzados para cumplir 3×100
    const LIMIT_FIXED = 100
    const PAGES_FIXED = 3

    const placeId = Number(request.input('placeId', 109983668079237))
    const excludeFullGames = !!request.input('excludeFullGames', true)
    const order: 'Asc' | 'Desc' =
      String(request.input('order', 'Asc')).toLowerCase() === 'desc' ? 'Desc' : 'Asc'
    const skipPages = Math.max(0, Number(request.input('skip', 0)) || 0)

    let cursor: string | null = null
    const allIds: string[] = []

    const fetchPage = async (pageIdx: number): Promise<AxiosResponse> => {
      let attempt = 0
      const maxRetries = 2

      while (true) {
        attempt++
        const params: any = { sortOrder: order, excludeFullGames, limit: LIMIT_FIXED }
        if (cursor) params.cursor = cursor

        const resp = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params,
            headers: {
              'Accept': 'application/json',
              'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
              'X-Page-Idx': String(pageIdx),
              'X-Order': order,
            },
            validateStatus: () => true,
            timeout: 10000,
          }
        )

        // Enviar SIEMPRE el response de la página al webhook
        await postDebug({
          stage: pageIdx < 0 ? 'skip' : 'collect',
          pageIdx,
          order,
          placeId,
          status: resp.status,
          headers: {
            'retry-after': resp.headers?.['retry-after'] ?? null,
            'x-rblx-challenge-id': resp.headers?.['x-rblx-challenge-id'] ?? null,
            'x-rate-limit-remaining': resp.headers?.['x-rate-limit-remaining'] ?? null,
          },
          body: resp.data, // cuerpo tal cual para ver el error en webhook.site
        })

        if (resp.status >= 200 && resp.status < 300) return resp
        if (
          (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) &&
          attempt < maxRetries
        ) {
          continue // reintento inmediato, SIN random
        }
        return resp
      }
    }

    try {
      // 0) Saltar páginas (NO recolecta, solo posiciona cursor)
      for (let s = 0; s < skipPages; s++) {
        const r = await fetchPage(-(s + 1))
        if (r.status < 200 || r.status >= 300) {
          return response.status(r.status).json({
            ok: false,
            stage: 'skip',
            pageTried: s + 1,
            upstream: r.data,
          })
        }
        cursor = r.data?.nextPageCursor ?? null
        if (!cursor) break
      }

      // 1) Recolectar exactamente 3 páginas; si una trae <100, avanzamos hasta completar 100 o agotar cursor
      for (let p = 0; p < PAGES_FIXED; p++) {
        let got = 0
        while (got < LIMIT_FIXED) {
          const r = await fetchPage(p)
          if (r.status < 200 || r.status >= 300) {
            return response.status(r.status).json({
              ok: false,
              stage: 'collect',
              pageTried: p + 1,
              upstream: r.data,
            })
          }

          const arr = Array.isArray(r.data?.data) ? r.data.data : []
          for (const s of arr) {
            const id = String(s?.id ?? '').trim()
            if (id) {
              allIds.push(id)
              got++
              if (got >= LIMIT_FIXED) break
            }
          }

          cursor = r.data?.nextPageCursor ?? null
          if (!cursor) break // no más páginas reales, seguimos con lo que hay
        }
        if (!cursor) break
      }

      return response.json({
        ok: true,
        placeId,
        order,
        skipped: skipPages,
        pages: PAGES_FIXED,
        limit: LIMIT_FIXED,
        count: allIds.length, // normalmente 300 si hay abundancia y no hubo cortes
        servers: allIds.map((id) => ({ id })), // SOLO id
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
