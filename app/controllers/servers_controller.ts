import type { HttpContext } from '@adonisjs/core/http'
import axios from 'axios'

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    const placeId = Number(request.input('placeId', 109983668079237))
    const order: 'Asc' | 'Desc' =
      String(request.input('order', 'Asc')).toLowerCase() === 'desc' ? 'Desc' : 'Asc'
    const excludeFullGames = !!request.input('excludeFullGames', true)

    const pages = Math.max(1, Number(request.input('pages', 3)) || 3)   // 3 por default
    const limit = 100                                                   // Roblox topea en 100
    const skip = Math.max(0, Number(request.input('skip', 0)) || 0)     // ventana disjunta

    let cursor: string | null = null
    const ids: string[] = []

    const fetchOnce = async () => {
      const params: any = { sortOrder: order, excludeFullGames, limit }
      if (cursor) params.cursor = cursor

      const r = await axios.get(
        `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
        { params, validateStatus: () => true, timeout: 8000 }
      )
      if (r.status < 200 || r.status >= 300) {
        return { ok: false as const, status: r.status, body: r.data, next: null, data: [] as any[] }
      }
      const data = Array.isArray(r.data?.data) ? r.data.data : []
      const next = r.data?.nextPageCursor ?? null
      return { ok: true as const, status: r.status, body: r.data, next, data }
    }

    try {
      // 0) Saltar 'skip' páginas (no recolecta, solo avanza cursor)
      for (let i = 0; i < skip; i++) {
        const r = await fetchOnce()
        if (!r.ok) return response.status(r.status).json({ ok: false, stage: 'skip', upstream: r.body })
        cursor = r.next
        if (!cursor) break
      }

      // 1) Recolectar exactamente `pages` páginas de 100 cada una (si hay cursor suficiente)
      for (let p = 0; p < pages; p++) {
        const r = await fetchOnce()
        if (!r.ok) {
          return response.status(r.status).json({ ok: false, stage: 'collect', page: p + 1, upstream: r.body })
        }

        // Solo ID
        for (const it of r.data) {
          const id = String(it?.id ?? '').trim()
          if (id) ids.push(id)
        }

        cursor = r.next
        if (!cursor && p < pages - 1) break // si se agotara (poco probable), salimos
      }

      return response.json({
        ok: true,
        placeId,
        order,
        skipped: skip,
        pages,
        limit,
        count: ids.length,               // típicamente 300
        servers: ids.map((id) => ({ id }))
      })
    } catch (e: any) {
      const ax = e?.response
      if (ax) return response.status(ax.status || 502).json({ ok: false, upstream: ax.data || null })
      return response.status(502).json({ ok: false, error: e?.message || 'proxy_error' })
    }
  }
}
