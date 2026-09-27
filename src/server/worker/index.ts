import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { runWorkerProcess } from "./start";

runWorkerProcess().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
