/**
 * /test-chat — internal harness for chatting with the agent without going
 * through Interakt. Gated by ENABLE_TEST_CHAT=1; returns 404 otherwise.
 */
import { notFound } from "next/navigation";
import { TestChatClient } from "./test-chat-client";

export default function TestChatPage() {
  if (process.env.ENABLE_TEST_CHAT !== "1") notFound();
  return <TestChatClient />;
}
