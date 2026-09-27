import { requireAdmin } from "@/server/admin/auth";
import { TestChatClient } from "./test-chat-client";

export default async function TestChatPage() {
  await requireAdmin();
  return <TestChatClient />;
}
