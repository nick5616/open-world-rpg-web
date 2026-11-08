// Default ports and endpoints for local development. Mirrors
// server/pkg/env/env.go; every value can be overridden by the same env var.
export const config = {
  pgPort: +(process.env.LODESTONE_PG_PORT ?? 55432),
  redisPort: +(process.env.LODESTONE_REDIS_PORT ?? 56379),
  livekitPort: +(process.env.LODESTONE_LIVEKIT_PORT ?? 7880),
  directorPort: +(process.env.LODESTONE_DIRECTOR_PORT ?? 8090),
  accountPort: +(process.env.LODESTONE_ACCOUNT_PORT ?? 8091),
  zonePort: +(process.env.LODESTONE_ZONE_PORT ?? 8092),
  socialPort: +(process.env.LODESTONE_SOCIAL_PORT ?? 8093),
  creatorPort: +(process.env.LODESTONE_CREATOR_PORT ?? 8094),
  clientPort: +(process.env.LODESTONE_CLIENT_PORT ?? 5173),
};

export function serviceEnv() {
  return {
    LODESTONE_PG_URL: process.env.LODESTONE_PG_URL ?? `postgres://lodestone:lodestone@127.0.0.1:${config.pgPort}/lodestone?sslmode=disable`,
    LODESTONE_REDIS_ADDR: process.env.LODESTONE_REDIS_ADDR ?? `127.0.0.1:${config.redisPort}`,
    LODESTONE_LIVEKIT_URL: process.env.LODESTONE_LIVEKIT_URL ?? `ws://localhost:${config.livekitPort}`,
    LODESTONE_LIVEKIT_KEY: process.env.LODESTONE_LIVEKIT_KEY ?? 'devkey',
    LODESTONE_LIVEKIT_SECRET: process.env.LODESTONE_LIVEKIT_SECRET ?? 'secret',
    LODESTONE_DIRECTOR_PORT: String(config.directorPort),
    LODESTONE_ACCOUNT_PORT: String(config.accountPort),
    LODESTONE_ZONE_PORT: String(config.zonePort),
    LODESTONE_SOCIAL_PORT: String(config.socialPort),
    LODESTONE_CREATOR_PORT: String(config.creatorPort),
  };
}
