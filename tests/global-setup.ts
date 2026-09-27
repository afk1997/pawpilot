import { runMigrations } from "@/server/db/migrate";

export default async function globalSetup(): Promise<void> {
  await runMigrations(process.env.TEST_DATABASE_URL ?? "postgres://arham:arham@localhost:5439/arham_test");
}
