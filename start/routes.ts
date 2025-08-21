import router from '@adonisjs/core/services/router'

// Import dinámico del controlador
const ServersController = () => import('#controllers/servers_controller')

// Rutas base
router.get('/', async () => ({ ok: true, service: 'scrapper', time: new Date().toISOString() }))
router.get('/health', async () => ({ ok: true }))

// Nueva ruta de servidores
router.get('/servers', [ServersController, 'servers'])
