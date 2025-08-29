import type { HttpContext } from '@adonisjs/core/http'
import axios from 'axios'

export default class ServersController {
  public async servers({ request, response }: HttpContext) {
    try {
      const order = request.input('order', 'Asc')
      const placeId = 109983668079237
      const limit = 100
      const pagesToFetch = 3

      let cursor: string | null = ''
      let allServers: any[] = []

      for (let i = 0; i < pagesToFetch; i++) {
        if (cursor === null) break

        // @ts-ignore
        const { data, status } = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params: {
              cursor,
              sortOrder: order,
              excludeFullGames: true,
              limit,
            },
            headers: { Accept: 'application/json' },
            validateStatus: () => true,
          }
        )

        if (status < 200 || status >= 300) {
          return response.status(status).json({
            ok: false,
            error: 'roblox_api_error',
            page: i + 1,
          })
        }

        const arr = Array.isArray(data?.data) ? data.data : []
        allServers.push(...arr)

        cursor = data?.nextPageCursor || null
        if (!cursor) break
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
    } catch (err) {
      return response.status(502).json({
        ok: false,
        error: (err as any)?.message ?? 'proxy_error',
      })
    }
  }
}
