import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Defense in depth: dispatcher dashboard endpoints must not surface test
  // conversations even if a stale id is passed.
  const { data: convo } = await supabase
    .from("conversations")
    .select("id, is_test")
    .eq("id", id)
    .maybeSingle();
  if (!convo || convo.is_test) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const { data: messages, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(messages);
}
