# Dashboard

Interfaz React + Ant Design para monitoreo operativo en tiempo real del ecosistema de bots.

## Funcionalidades actuales
- Conexión en vivo al `dashboard-gateway` por WebSocket.
- Tabla de eventos con payload completo.
- Filtros por scope (`All`, `Health`, `System`, `Redis`).
- Filtro dinámico por canal y búsqueda de texto.
- Métricas de conexión y volumen de eventos.

## Fuente de datos
- WebSocket: `ws://localhost:7010/ws` (configurable con `VITE_DASHBOARD_WS_URL`).

## Ejecutar local

Desde la raíz del monorepo:

```bash
bun run dev:dashboard
```

O desde este directorio:

```bash
bun run --cwd apps/dashboard dev
```

## Build producción
```bash
bun run --cwd apps/dashboard build
```

## Estado actual
MVP operativo. Pendientes recomendados: persistencia de filtros, virtualización avanzada y paneles de estrategia/inventario.
