module.exports = {
  apps: [
    {
      name: "a2e-api",
      cwd: "/opt/a2e/apps/api",
      script: "npm",
      args: "start",
      env: {
        PORT: 3000,
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://a2e:a2e_secure_pass_2026@localhost:5432/a2e_engine",
        REDIS_URL: "redis://localhost:6379",
        API_KEY: "a2e-dev-key-2026",
        AKASH_ENABLED: "true",
        IONET_ENABLED: "false",
        RATE_FETCH_INTERVAL_MS: 60000,
        HEARTBEAT_CHECK_INTERVAL_MS: 10000,
        LOG_LEVEL: "info",
      },
    },
    {
      name: "a2e-dashboard",
      cwd: "/opt/a2e/apps/dashboard",
      script: "node",
      args: ".next/standalone/apps/dashboard/server.js",
      env: {
        PORT: 3001,
        HOSTNAME: "0.0.0.0",
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://tokenosdeai-api.onrender.com",
        NEXT_PUBLIC_API_KEY: "a2e-dev-key-2026",
      },
    },
  ],
};
