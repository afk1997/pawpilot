import { requireAdmin } from "@/server/admin/auth";
import { Transcript } from "../_components/transcript";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  return (
    <main className="h-screen bg-[#0f0f0f] text-white">
      <Transcript id={id} />
    </main>
  );
}
