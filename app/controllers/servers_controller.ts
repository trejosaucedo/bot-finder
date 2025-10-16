import type { HttpContext } from '@adonisjs/core/http'
import axios, { AxiosResponse } from 'axios'

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    // Forzados para cumplir 3×100
    const LIMIT_FIXED = 100
    const PAGES_FIXED = 3

    const placeId = Number(request.input('placeId', 109983668079237))
    const excludeFullGames = !!request.input('excludeFullGames', true)
    const order: 'Asc' | 'Desc' =
      String(request.input('order', 'Asc')).toLowerCase() === 'desc' ? 'Desc' : 'Asc'
    // Ventana opcional: saltar N páginas antes de recolectar
    const skipPages = Math.max(0, Number(request.input('skip', 0)) || 0)

    let cursor: string | null = null
    const allIds: string[] = []

    // Fetch de UNA página con reintentos rápidos (sin sleeps)
    const fetchPage = async (pageIdx: number): Promise<AxiosResponse> => {
      const maxRetries = 2
      let attempt = 0

      while (true) {
        attempt++
        const params: any = {
          sortOrder: order,
          excludeFullGames,
          limit: LIMIT_FIXED,
        }
        if (cursor) params.cursor = cursor

        const resp = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params,
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
              'X-Page-Idx': String(pageIdx),
              'X-Order': order,
            },
            validateStatus: () => true,
            timeout: 8000,
          }
        )

        if (resp.status >= 200 && resp.status < 300) return resp
        if ((resp.status === 429 || (resp.status >= 500 && resp.status < 600)) && attempt < maxRetries) {
          // reintento inmediato, sin delay
          continue
        }
        return resp
      }
    }

    try {
      // 1) Avanza 'skipPages' páginas sin recolectar (posiciona ventana)
      for (let s = 0; s < skipPages; s++) {
        const r = await fetchPage(-(s + 1))
        if (r.status < 200 || r.status >= 300) {
          return response.status(r.status).json({
            ok: false,
            stage: 'skip',
            pageTried: s + 1,
            upstream: { status: r.status, statusText: r.statusText, body: r.data },
          })
        }
        cursor = r.data?.nextPageCursor ?? null
        if (!cursor) break // improbable si hay miles, pero defensivo
      }

      // 2) Recolecta exactamente 3 páginas (100 c/u)
      for (let i = 0; i < PAGES_FIXED; i++) {
        const r = await fetchPage(i)
        if (r.status < 200 || r.status >= 300) {
          return response.status(r.status).json({
            ok: false,
            stage: 'collect',
            pageTried: i + 1,
            upstream: { status: r.status, statusText: r.statusText, body: r.data },
          })
        }

        const arr = Array.isArray(r.data?.data) ? r.data.data : []
        for (const s of arr) {
          const id = String(s?.id ?? '').trim()
          if (id) allIds.push(id)
        }

        cursor = r.data?.nextPageCursor ?? null
        if (!cursor && i < PAGES_FIXED - 1) break // si se agotara, salimos
      }

      return response.json({
        ok: true,
        placeId,
        order,
        skipped: skipPages,
        pages: PAGES_FIXED,
        limit: LIMIT_FIXED,
        count: allIds.length, // normalmente 300
        servers: allIds.map((id) => ({ id })), // SOLO id
      })
    } catch (err: any) {
      const axiosResp = err?.response
      if (axiosResp) {
        return response.status(axiosResp.status || 502).json({
          ok: false,
          upstream: {
            status: axiosResp.status,
            statusText: axiosResp.statusText,
            body: axiosResp.data || null,
          },
        })
      }
      return response.status(502).json({
        ok: false,
        error: err?.code || err?.message || 'proxy_error',
      })
    }
  }
}
