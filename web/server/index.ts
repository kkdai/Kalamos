import { once } from "node:events";
import process from "node:process";
import { migrate, openDatabase } from "./database.ts";
import { allowedHosts, createHttpServer } from "./http.ts";

const host = process.env.KALAMOS_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.KALAMOS_WEB_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("KALAMOS_WEB_PORT must be an integer from 1 to 65535.");
}
const hosts = allowedHosts(port, process.env.KALAMOS_WEB_ALLOWED_HOSTS);
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://kalamos:kalamos_dev@127.0.0.1:5432/kalamos";
const pool = openDatabase(databaseUrl);

try {
  await migrate(pool);
} catch {
  await pool.end();
  console.error(
    "Could not initialize PostgreSQL. Check DATABASE_URL, database health, and migration permissions.",
  );
  process.exit(1);
}

const server = createHttpServer(pool, hosts);
try {
  server.listen(port, host);
  await once(server, "listening");
} catch {
  await pool.end();
  console.error(
    "Could not start the Web API. Check KALAMOS_WEB_HOST and KALAMOS_WEB_PORT.",
  );
  process.exit(1);
}
console.log(`Kalamos Web listening on ${host}:${port}.`);

function stop() {
  server.close(() => {
    pool.end().catch(() => {
      process.exitCode = 1;
    });
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
