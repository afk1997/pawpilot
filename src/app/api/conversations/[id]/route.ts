import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { audit } from "@/lib/audit";

/**
 * Update conversation mode/status from the dashboard. Mode flips between
 * 'agent' (auto-reply) and 'human' (dispatcher took over). When a dispatcher
 * takes over, we also stamp claimed_by + claimed_at and audit the action.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json()) as {
    mode?: "agent" | "human";
    status?: string;
    claimed_by?: string | null;
  };

  if (body.mode && !["agent", "human"].includes(body.mode)) {
    return Response.json({ error: "Invalid mode" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.mode) update.mode = body.mode;
  if (body.status) update.status = body.status;
  if (body.claimed_by !== undefined) {
    update.claimed_by = body.claimed_by;
    update.claimed_at = body.claimed_by ? new Date().toISOString() : null;
  }

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", id)
    .eq("is_test", false)
    .select()
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Audit takeover/release events.
  if (body.mode === "human" && body.claimed_by) {
    await audit({
      conversationId: id,
      actionType: "dispatcher_takeover",
      actor: body.claimed_by,
      metadata: update,
    });
  } else if (body.mode === "agent" && body.claimed_by === null) {
    await audit({
      conversationId: id,
      actionType: "dispatcher_release",
      metadata: update,
    });
  } else {
    await audit({
      conversationId: id,
      actionType: "status_change",
      metadata: update,
    });
  }

  return Response.json(data);
}
