import type { HttpContext } from '@adonisjs/core/http'
import axios, { AxiosResponse } from 'axios'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    const order = request.input('order', 'Asc') // 'Asc' | 'Desc' (funciona en Roblox)
    const placeId = 109983668079237
    const limit = Number(request.input('limit', 50)) // 10|25|50|100
    const pagesToFetch = Number(request.input('pages', 3)) // hasta 3
    const excludeFullGames = request.input('excludeFullGames', true) ? true : false

    let cursor: string | null = null
    const allServers: any[] = []

    // === helper: fetch con anti-ratelimit y propagando error real ===
    const fetchPage = async (pageIdx: number): Promise<AxiosResponse> => {
      const maxRetries = 3
      let attempt = 0

      // Nota: no incluimos 'cursor' si es null
      const mkParams = () => {
        const p: any = { sortOrder: order, excludeFullGames, limit }
        if (cursor) p.cursor = cursor
        return p
      }

      // user-agent “normal”
      const headers = {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'X-Page-Idx': String(pageIdx),
      }

      while (true) {
        attempt++
        const resp = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params: mkParams(),
            headers,
            // No lances por status != 2xx; queremos el cuerpo real
            validateStatus: () => true,
            timeout: 8000,
          }
        )

        // 2xx → devolver
        if (resp.status >= 200 && resp.status < 300) return resp

        // 429 → respetar Retry-After y reintentar (hasta maxRetries)
        if (resp.status === 429 && attempt < maxRetries) {
          const ra = Number(resp.headers?.['retry-after'] ?? 0)
          const waitMs = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800) + Math.random() * 400
          await sleep(waitMs)
          continue
        }

        // 5xx → backoff exponencial con jitter (hasta maxRetries)
        if (resp.status >= 500 && resp.status < 600 && attempt < maxRetries) {
          const waitMs = Math.min(2000 * attempt, 4000) + Math.random() * 300
          await sleep(waitMs)
          continue
        }

        // Si llegamos aquí, devolvemos tal cual (error real del upstream)
        return resp
      }
    }

    try {
      for (let i = 0; i < pagesToFetch; i++) {
        const resp = await fetchPage(i)

        // Si no es 2xx, propaga el error REAL
        if (resp.status < 200 || resp.status >= 300) {
          return response.status(resp.status).json({
            ok: false,
            page: i + 1,
            upstream: {
              url: resp.config?.url,
              status: resp.status,
              statusText: resp.statusText,
              // algunos headers útiles para diagnosticar rate limits
              headers: {
                'retry-after': resp.headers?.['retry-after'] ?? null,
                'x-rblx-challenge-id': resp.headers?.['x-rblx-challenge-id'] ?? null,
                'x-rate-limit-remaining': resp.headers?.['x-rate-limit-remaining'] ?? null,
              },
              body: resp.data, // cuerpo crudo de Roblox (aquí está el “error real”)
            },
          })
        }

        const data = resp.data
        const arr = Array.isArray(data?.data) ? data.data : []
        allServers.push(...arr)

        cursor = data?.nextPageCursor ?? null
        if (!cursor) break

        // pequeña pausa entre páginas para suavizar rate limit
        await sleep(250 + Math.random() * 250)
      }

      return response.json({
        ok: true,
        servers: allServers.map((s) => ({
          id: s.id,
          playing: s.playing,
          maxPlayers: s.maxPlayers,
          ping: s.ping,
        })),
      })
    } catch (err: any) {
      // Error de red/axios → propagar detalle real también
      const axiosResp = err?.response
      if (axiosResp) {
        return response.status(axiosResp.status || 502).json({
          ok: false,
          upstream: {
            status: axiosResp.status,
            statusText: axiosResp.statusText,
            headers: axiosResp.headers || null,
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
