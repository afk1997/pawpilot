import { requireAdmin } from "@/server/admin/auth";
import { ConversationList } from "./_components/conversation-list";

export default async function AdminPage() {
  await requireAdmin();
  return <ConversationList />;
}
